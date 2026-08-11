/* 段取りたび — 制約ソルバー
   コアAPI（CLAUDE.md §3・変更禁止）:
     judge(person, attraction) -> { s:'ok'|'edge'|'ng', gap:cm }
     solve()                   -> Finding[]
     derive()                  -> Step[]
     bookings(today)           -> Booking[]
     course(opts)              -> { steps, warns } | null   ← F6（パーク内の回り順）
   データは configure() で注入する（①はHTML埋め込み、テストは data/*.json 直読み）。 */
(function (g) {
  'use strict';

  const EDGE_CM = 5;
  const DEFAULT_WAIT = 45;

  let ATTRACTIONS = [];
  let RULES = [];
  let LAYOUT = null;
  let STATE = emptyTrip();

  /* schemaVersion 3: trips 配列で複数旅行を持つ（ファイル形式）。
     solver が configure() で受けるのは trips[i] の1旅行スライス。 */
  function emptyTrip() {
    return {
      name: '旅行1', budget: null,
      trip: { start: null, end: null, transports: [] },
      people: [], constraints: [], tickets: [],
      hotel: null, flight: null, train: null, booked: {},
      /* F6（回り順）用。未入力なら park-layout の既定値と「未定」で動く */
      parkHours: { open: null, close: null, waitMin: null },
    };
  }
  function emptyState() {
    return { schemaVersion: 3, activeTrip: 't1', trips: [{ id: 't1', ...emptyTrip() }] };
  }
  function migrateState(s) {
    if (!s) return null;
    if (s.schemaVersion === 3) return Array.isArray(s.trips) && s.trips.length ? s : null;  // 壊れたv3で白画面にしない
    if (s.schemaVersion === 1) {
      const t = s.trip || {};
      const transports = [];
      if (t.trainDate) transports.push({ leg: 'outbound', mode: 'train', date: t.trainDate });
      if (t.flightDate) transports.push({ leg: 'return', mode: 'flight', date: t.flightDate });
      s = { ...s, schemaVersion: 2, trip: { start: t.start || null, end: t.end || null, transports } };
    }
    if (s.schemaVersion !== 2) return null;
    return { schemaVersion: 3, activeTrip: 't1', trips: [{
      id: 't1', name: '旅行1', budget: null,
      trip: s.trip, people: s.people || [], constraints: s.constraints || [],
      tickets: s.tickets || [], hotel: s.hotel || null, flight: s.flight || null,
      train: s.train || null, booked: s.booked || {},
    }] };
  }

  function configure(opts) {
    if (opts.attractions) ATTRACTIONS = opts.attractions;
    if (opts.rules) RULES = opts.rules;
    if (opts.layout) LAYOUT = opts.layout;
    if (opts.state) STATE = opts.state;
  }

  /* ── 時刻ユーティリティ ── */
  const toMin = t => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };
  const toStr = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

  /* ★「1ヶ月前」は暦月で引く。-30日だと 9/20→8/21 になり1日遅れて詰む。
     航空券の「360日前」は日数。両方が混在するので offsetMonths / offsetDays を別に持つ */
  function shift(iso, m, d) {
    const x = new Date(iso + 'T00:00:00');
    if (m) x.setMonth(x.getMonth() + m);
    if (d) x.setDate(x.getDate() + d);
    return x;
  }
  const isoDate = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;

  /* ── F1. 身長判定 ──
     公式の構造は2段：単独利用は minHeight、付き添い者同伴なら minHeightWithAdult まで下がる
     （null=同伴なら制限なし）。家族に大人がいれば同伴値で判定する。schemaVersion 1 データ
     （minHeightWithAdult 未定義）は minHeight のみで従来どおり動く */
  function effectiveMin(a) {
    const hasAdult = STATE.people.some(q => q.adult);
    if (hasAdult && 'minHeightWithAdult' in a) return a.minHeightWithAdult;
    const m = a.minHeight !== undefined ? a.minHeight : a.min;
    return m === undefined ? null : m;
  }
  function judge(p, a) {
    const min = effectiveMin(a);
    const max = a.maxHeight !== undefined ? a.maxHeight : null;
    if (p.h === null || p.h === undefined) return min === null ? { s: 'ok', gap: 0 } : { s: 'unknown', gap: null };
    if (max !== null && p.h > max) return { s: 'ng', gap: 0, over: true };
    if (min === null || p.h >= min) return { s: 'ok', gap: 0 };
    const gap = min - p.h;
    return { s: gap <= EDGE_CM ? 'edge' : 'ng', gap };
  }

  function verdictCounts(p) {
    const c = { ok: 0, edge: 0, ng: 0, unknown: 0 };
    ATTRACTIONS.forEach(a => { c[judge(p, a).s]++; });
    return c;
  }

  /* チケットの対象アトラクション名をマスタへ突合する（正規化済み前提） */
  function matchAttraction(name) {
    const n = g.DandoriParser ? g.DandoriParser.norm(name) : name;
    return ATTRACTIONS.find(a =>
      (g.DandoriParser ? g.DandoriParser.norm(a.name) : a.name) === n ||
      a.short === n || a.id === n) || null;
  }

  /* ── F2〜F5. 破綻検出 ──
     today（ISO日付）を渡すと「もう予約できるのに押さえていない」も検出する（G）。
     省略時は日付に依存する検出だけを飛ばす */
  function solve(today) {
    const f = [];
    const kids = STATE.people.filter(p => !p.adult);
    const naps = STATE.constraints.filter(c => c.type === 'nap');
    const dep = STATE.constraints.find(c => c.type === 'departure');

    /* A. 時間指定 × 再入場不可 × 昼寝の衝突（F2） */
    STATE.tickets.forEach(t => (t.fixed || t.slots || []).forEach(s => {
      if (s.reentry === false && s.until) {
        naps.forEach(c => {
          const S = toMin(s.at), E = toMin(s.until), a = toMin(c.from), b = toMin(c.to);
          if (S < b && a < E) {
            f.push({ lv: 'warn', kind: 'conflict', ti: '時間指定と昼寝が重なります',
              dt: `${s.name} は ${s.at}〜 で再入場できません。${c.label}（${c.from}–${c.to}）と時間帯が接触します。`,
              fix: `昼寝を ${s.until} 以降にずらす。エリアは一度の滞在で完結させる前提で組む。` });
          } else if (Math.abs(E - a) <= 30) {
            f.push({ lv: 'note', kind: 'adjacent', ti: '昼寝は指定枠の直後に置けます',
              dt: `${s.name}（${s.at}〜${s.until}・再入場不可）を終えてから ${c.label} に入る形なら衝突しません。`,
              fix: `午前は下の子向け → ${s.at} に指定枠 → ${s.until} からホテルで休憩、の順に固定。` });
          }
        });
      }
    }));

    /* B. 券のムダ枠（F2）。無駄と断定せず子どもスイッチを併記する */
    STATE.tickets.forEach(t => {
      const freeNames = (t.free || []);
      const dead = freeNames.map(matchAttraction)
        .filter(a => a && kids.length && !kids.some(p => judge(p, a).s === 'ok'));
      if (dead.length) {
        f.push({ lv: 'note', kind: 'deadSlot', ti: '子どもが使えない枠が含まれています',
          dt: `${t.name} の対象のうち ${dead.map(a => a.name).join('、')} は、いまの身長だと子どもは全員乗れません。`,
          fix: '大人が交代で乗れば無駄になりません（子どもスイッチ）。券を選び直す段階なら、この枠がない構成が安い。' });
      }
      const used = (t.fixed || t.slots || []).map(s => s.ride ? ATTRACTIONS.find(a => a.id === s.ride) : matchAttraction(s.name))
        .filter(a => a && kids.some(p => judge(p, a).s === 'ok'));
      if (used.length) {
        f.push({ lv: 'good', kind: 'usable', ti: '時間指定の枠は子どもが乗れます',
          dt: `${[...new Set(used.map(a => a.name))].join('、')} は現在の身長で条件を満たしています。` });
      }
    });

    /* C. 身長の境界（F1）。当日は靴込みで計測される */
    kids.forEach(p => {
      if (p.h === null || p.h === undefined) return;
      const near = ATTRACTIONS.filter(a => judge(p, a).s === 'edge');
      if (near.length) {
        const gap = judge(p, near[0]).gap;
        f.push({ lv: 'note', kind: 'edge', ti: `${p.name}は あと${gap}cm で対象が増えます`,
          dt: `${near.map(a => a.name).join('、')} が ${effectiveMin(near[0])}cm。現在 ${p.h}cm。`,
          fix: '計測は当日パークで靴を履いた状態。厚めのソールで届く可能性があります。' });
      }
    });

    /* D. ★単一障害点（F5）。none×singlePoint は「予約不要」で終わらせない。
       代替経路と切替デッドラインを必ず生成する。
       appliesWhen で交通手段に条件づけ（例：リムジンバスは帰りが飛行機のときのみ） */
    RULES.filter(r => r.mode === 'none' && r.criticality === 'singlePoint' && ruleApplies(r)).forEach(r => {
      const fb = r.fallback || null;
      let deadline = null, busLeave = null;
      if (dep && fb && fb.extraMinutes != null) {
        /* 帰りの便から遡って通常経路の最終出発を出し、代替経路の所要差だけ前倒しした時刻が判断点 */
        busLeave = parkLeave(null);
        if (busLeave) deadline = toStr(toMin(busLeave) - fb.extraMinutes);
      }
      f.push({
        lv: 'warn', kind: 'singlePoint', ti: `単一障害点：${r.label}は予約で確保できません`,
        dt: `${r.note}${busLeave ? ` 通常経路の最終出発は ${busLeave}。` : ''}`,
        fix: fb
          ? `代替経路：${fb.route}（+${fb.extraMinutes}分）。` +
            (deadline
              ? `判断点は ${deadline}。この時刻までに乗車の見込みが立たなければ代替へ切り替える。`
              : '帰りの便が未定のため判断点を計算できません。便が決まり次第、切替時刻を逆算します。')
          : '代替経路が未登録です。booking-rules.json に fallback を追加してください。',
        deadline, ruleId: r.id,
      });
    });

    /* E. ★取消不可の順序トラップ。
       「早く押さえろ」が成立するのは取り消せるときだけ。取消不可のものを、
       まだ確定していない依存（宿・便・列車）より先に買うと、依存が取れなかったとき費用が戻らない */
    const active = RULES.filter(r => ruleApplies(r) && anchorTargets(r).length);
    const nonRef = active.filter(r => r.cancel && r.cancel.refundable === false && !allBooked(r));
    const pending = active.filter(r => r.mode !== 'none' && !allBooked(r) &&
      !(r.cancel && r.cancel.refundable === false));
    if (nonRef.length && pending.length) {
      const pendingLabels = pending.map(r => `${r.label}（${r.mode === 'unknown' ? '監視中' : '未確保'}）`);
      f.push({
        lv: 'warn', kind: 'cancelTrap',
        ti: `取消不可：${nonRef.map(r => r.label).join('・')}は買うと戻せません`,
        dt: `${pendingLabels.join('、')}がまだ確定していません。先に取消不可のものを買うと、これらが取れなかったとき費用が戻りません。`,
        fix: '取り消せるもの（新幹線330円・宿の無料キャンセル枠など）から先に確定し、取消不可のものは依存が固まり次第すぐ買う。変動価格の値上がりとのトレードオフはあるが、順序だけは守る。',
      });
    }

    /* G. ★もう予約できるのに押さえていない。
       解禁日を過ぎた窓は「期限切れ」ではなく開いている。待つほど席は減り、
       窓自体に閉じる時刻があるもの（事前申込・1年前予約）は、過ぎたら二度と使えない。
       取消できるかで行動が変わるので、cancel を必ず添えて出す */
    if (today) {
      const byRule = {};
      bookings(today).filter(b => b.state === '受付中')
        .forEach(b => (byRule[b.id] = byRule[b.id] || []).push(b));
      Object.values(byRule).forEach(bs => {
        const near = bs.slice().sort((a, b) => (a.endDays ?? 9999) - (b.endDays ?? 9999))[0];
        const r = bs[0];
        const cx = r.cancel || {};
        const act = cx.refundable === true
          ? `取り消せる（${cx.note || '要確認'}）。取り消せるものから先に確定させる順序でよい。`
          : cx.refundable === false
            ? '取消不可。宿・便が確定してから買う（順序を守る）。'
            : `取消規定を先に確認（${cx.note || '要確認'}）。`;
        f.push({
          lv: r.criticality === 'singlePoint' ? 'warn' : 'note',
          kind: 'openNow', ruleId: r.id,
          ti: `もう予約できます：${bs.map(b => b.label).join('・')}`,
          dt: `${r.iso}${r.at ? ' ' + r.at : ''} に解禁済みで、いま受付中です。`
            + (near.endIso ? `${near.endIso}${near.endAt ? ' ' + near.endAt : ''} で締切（あと${near.endDays}日）。` : '')
            + (r.note || ''),
          fix: act + (r.caution ? ` ※${r.caution}` : ''),
        });
      });
    }

    /* F. 予算超過（引き算）。判明金額の合計が予算を超えたら破綻として出す。
       削減候補は「取消可能なもの」だけ。取消不可を削る提案は事故のもとなので、
       削れない側として明示するに留める */
    if (typeof STATE.budget === 'number' && STATE.budget > 0) {
      const ruleOf = id => RULES.find(r => r.id === id) || null;
      const items = [];
      let unknown = 0;
      const put = (o, label, ruleId) => {
        if (!o) return;
        if (o.price != null) items.push({ label, price: o.price, rule: ruleOf(ruleId) });
        else unknown++;
      };
      put(STATE.hotel, '宿', 'hotel');
      put(STATE.train, '新幹線', 'jr');
      put(STATE.flight, '航空券', /^(ANA|NH)/.test((STATE.flight && STATE.flight.flightNo) || '') ? 'ana' : 'jal');
      (STATE.tickets || []).forEach(t => put(t, t.name, /エクスプレス/.test(t.name || '') ? 'express' : 'parkpass'));
      const total = items.reduce((s, x) => s + x.price, 0);
      if (total > STATE.budget) {
        const nonRefundable = x => x.rule && x.rule.cancel && x.rule.cancel.refundable === false;
        const cuttable = items.filter(x => !nonRefundable(x)).sort((a, b) => b.price - a.price);
        const locked = items.filter(nonRefundable);
        f.push({
          lv: 'warn', kind: 'budget',
          ti: `予算超過：合計¥${total.toLocaleString()} / 予算¥${STATE.budget.toLocaleString()}（超過¥${(total - STATE.budget).toLocaleString()}）`,
          dt: (unknown ? `金額不明の項目が${unknown}件あり、実際の合計はこれより増えます。` : '判明している金額の合計です。')
            + (locked.length ? ` 取消不可のため削れない：${locked.map(x => x.label).join('、')}。` : ''),
          fix: cuttable.length
            ? '削減候補（取消可能なものだけ・金額順）：' + cuttable.map(x =>
                `${x.label} ¥${x.price.toLocaleString()}${x.rule && x.rule.cancel && x.rule.cancel.note ? `（${x.rule.cancel.note}）` : ''}`).join(' / ')
            : '取消可能な削減候補がありません。取消不可のものを買う前に構成を見直すか、予算を再設定してください。',
        });
      }
    }

    return f;
  }

  /* あるルールの対象（行き/帰りで複数になりうる）がすべて予約済みか */
  function allBooked(r) {
    const targets = anchorTargets(r);
    if (!targets.length) return true;
    return targets.every(tg => {
      const key = r.id + (tg.leg && targets.length > 1 ? '@' + tg.leg : '');
      return !!STATE.booked[key];
    });
  }

  /* パークを出る時刻＝帰りの便から、移動レグまでを遡った時刻。
     F3（逆算）とF6（回り順の締切）が同じ値を使うための共通関数。
     day を渡すと「その日が帰りの日でなければ null」を返す（別日のパーク日に締切を持ち込まない） */
  function parkLeave(day) {
    const dep = (STATE.constraints || []).find(c => c.type === 'departure');
    if (!dep || !dep.at) return null;
    if (day) {
      const ret = (STATE.trip.transports || []).filter(t => t.leg === 'return' && t.date);
      if (ret.length && !ret.some(t => t.date === day)) return null;
    }
    let t = toMin(dep.at);
    const legs = dep.legs || [];
    const idxMove = legs.findIndex(l => /バス|移動|リムジン/.test(l.name));
    for (let i = 0; i <= (idxMove < 0 ? legs.length - 1 : idxMove); i++) t -= legs[i].min;
    return toStr(t);
  }

  /* ── F3. 当日逆算 ── */
  function derive() {
    const d = STATE.constraints.find(c => c.type === 'departure');
    if (!d) return [];
    let t = toMin(d.at);
    const out = [{ t: d.at, b: `${d.flight || '帰りの便'} ${d.airport || ''}発`.trim(), e: 'これが起点' }];
    (d.legs || []).forEach(l => { t -= l.min; out.unshift({ t: toStr(t), b: l.name, e: `${l.min}分` }); });
    out.unshift({ t: toStr(t - 30), b: 'ホテルで荷物を受け取る', e: 'チェックアウト後の預けから' });
    return out;
  }

  /* ── F4. 予約解禁の逆算 ──
     アンカーの解決：start/end は旅行日、train/flight は transports の該当手段すべて
     （往復新幹線なら JR 解禁は行き・帰りの2件になる）。旧 trainDate/flightDate も受ける */
  const LEG_LABEL = { outbound: '行き', return: '帰り' };

  function transportsDecided() {
    const ts = STATE.trip.transports || [];
    return ['outbound', 'return'].every(leg => ts.some(t => t.leg === leg && t.mode));
  }

  function ruleApplies(r) {
    if (r.watchOnly) return false;   // 監視(②)専用ルール。①の旅程には出さない
    /* 航空会社ルール：便名が分かっていれば他社のルールは出さない（JAL利用時にANAは不要） */
    if (r.carrier) {
      const fn = STATE.flight && STATE.flight.flightNo;
      if (fn) {
        const carrier = /^(JAL|JL)/.test(fn) ? 'JAL' : /^(ANA|NH)/.test(fn) ? 'ANA' : null;
        if (carrier && carrier !== r.carrier) return false;
      }
    }
    if (!r.appliesWhen) return true;
    const ts = STATE.trip.transports || [];
    const m = r.appliesWhen.returnMode;
    if (m) {
      if (ts.some(t => t.leg === 'return' && t.mode === m)) return true;
      /* 帰りの手段が未定なら適用の可能性が残る＝隠さない。確定済みで不一致なら適用外 */
      return !ts.some(t => t.leg === 'return' && t.mode);
    }
    return true;
  }

  function anchorTargets(r) {
    const tr = STATE.trip;
    if (r.anchor === 'start' || r.anchor === 'end') return [{ date: tr[r.anchor] || null, leg: null }];
    const mode = (r.anchor === 'train' || r.anchor === 'trainDate') ? 'train'
      : (r.anchor === 'flight' || r.anchor === 'flightDate') ? 'flight' : null;
    if (!mode) return [{ date: null, leg: null }];
    const ts = (tr.transports || []).filter(t => t.mode === mode);
    if (ts.length) return ts.map(t => ({ date: t.date || null, leg: t.leg }));
    /* その手段を使わないと確定していればルール自体を出さない。未定なら「未定」で出す */
    return transportsDecided() ? [] : [{ date: null, leg: null }];
  }

  /* ★offset* は「窓が開く日」であって締切ではない。解禁日を過ぎた＝もう予約できる（受付中）。
     これを「期限切れ」と表示すると、いま押さえられるものを取り逃す。
     窓が閉じる側は rule.end（省略時は anchor 当日＝乗車日・搭乗日・来園日）。
     ※日付粒度で判定する（today は日付のみ）。開く/閉じる当日は時刻を併記して判断を委ねる */
  function windowEnd(r, base) {
    if (!base) return null;
    const e = r.end || { offsetMonths: 0, offsetDays: 0, at: null };
    return { when: shift(base, e.offsetMonths || 0, e.offsetDays || 0), at: e.at || null };
  }

  function bookings(today) {
    const T = new Date(today + 'T00:00:00');
    const out = [];
    RULES.filter(ruleApplies).forEach(r => {
      const targets = anchorTargets(r);
      targets.forEach(tg => {
        const base = tg.date;
        const needsDate = !(r.mode === 'asap' || r.mode === 'none');
        const when = (base && needsDate) ? shift(base, r.offsetMonths || 0, r.offsetDays || 0) : null;
        const days = when ? Math.round((when - T) / 86400000) : null;
        const end = (r.mode === 'none' || r.mode === 'unknown') ? null : windowEnd(r, base);
        const endDays = end ? Math.round((end.when - T) / 86400000) : null;
        const key = r.id + (tg.leg && targets.length > 1 ? '@' + tg.leg : '');
        const done = !!STATE.booked[key];
        const open = days !== null && days < 0;                 // 解禁済み
        const closed = endDays !== null && endDays < 0;         // 窓が閉じた
        const state =
          r.mode === 'none' ? '予約不可' :
          done ? '済' :
          (needsDate && !base) ? '未定' :
          r.mode === 'unknown' ? '監視中' :
          closed ? '締切' :
          open ? '受付中' : '未';
        out.push({
          ...r, when, days, done, key,
          label: r.label + (tg.leg && targets.length > 1 ? `（${LEG_LABEL[tg.leg]}）` : ''),
          iso: when ? isoDate(when) : null,
          endIso: end ? isoDate(end.when) : null, endAt: end ? end.at : null, endDays,
          state,
        });
      });
    });
    return out.sort((a, b) => {
      /* 受付中＝いま行動できる。いちばん上に置く（下に埋もれると取り逃す） */
      const rank = x => x.state === '受付中' ? 0 : x.state === '未' ? 1 : x.state === '監視中' ? 2 :
                        x.state === '未定' ? 3 : x.state === '予約不可' ? 4 : x.state === '済' ? 5 : 6;
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      /* 受付中どうしは「先に閉じる窓」が上 */
      if (a.state === '受付中' && b.state === '受付中') return (a.endDays ?? 9999) - (b.endDays ?? 9999);
      return (a.days ?? 9999) - (b.days ?? 9999);
    });
  }

  /* 同日に複数締切が重なる場合の明示（F4。例：8/20 の 10:00 と 11:00） */
  function overlaps(today) {
    const byDay = {};
    bookings(today).filter(b => b.iso && b.state === '未').forEach(b => {
      (byDay[b.iso] = byDay[b.iso] || []).push(b);
    });
    return Object.entries(byDay).filter(([, v]) => v.length > 1)
      .map(([day, v]) => ({ day, items: v.map(b => `${b.at || '終日'} ${b.label}`) }));
  }

  /* ── 未定項目の収集（「これから決めること」欄へ自動で流す） ── */
  function undecided() {
    const u = [];
    STATE.people.forEach(p => {
      if (p.h === null || p.h === undefined) u.push({ what: `${p.name}の身長`, why: '判定の起点。1cmで乗れるものが変わる' });
    });
    if (!STATE.trip.start) u.push({ what: '旅行日', why: '予約解禁日の逆算に必要' });
    const ts = STATE.trip.transports || [];
    const MODE_LABEL = { train: '新幹線', flight: '飛行機', bus: 'バス', car: '車' };
    ['outbound', 'return'].forEach(leg => {
      const t = ts.find(x => x.leg === leg && x.mode);
      if (!t) u.push({ what: `${LEG_LABEL[leg]}の交通手段`, why: '手段で予約ルールと単一障害点の検査が変わる' });
      else if (!t.date) u.push({ what: `${LEG_LABEL[leg]}の${MODE_LABEL[t.mode] || t.mode}の日付`, why: '解禁日の逆算に必要' });
    });
    if (ts.some(x => x.leg === 'return' && x.mode) && !STATE.constraints.some(c => c.type === 'departure')) {
      u.push({ what: '帰りの出発時刻', why: '当日の締切と単一障害点の判断点を逆算できない' });
    }
    const infants = STATE.people.filter(p => !p.adult && p.age !== null && p.age <= 3);
    if (infants.length && !STATE.constraints.some(c => c.type === 'nap')) {
      u.push({ what: `昼寝の時間帯（${infants.map(p => p.name).join('・')}）`, why: '再入場不可の時間指定と衝突しうる' });
    }
    if (STATE.hotel && !STATE.hotel.checkIn) u.push({ what: '宿のチェックイン日', why: '解禁監視・逆算に必要' });
    STATE.tickets.forEach(t => { if (!t.date) u.push({ what: `${t.name}の入場日`, why: '時間指定の衝突検査に必要' }); });
    /* パーク当日の開園・閉園（F6の区間計算に必要。閉園は帰りの便から逆算できれば不要） */
    const pday = parkDay();
    if (ring().length && pday) {
      const ph = STATE.parkHours || {};
      if (!ph.open && !(STATE.tickets || []).some(t => t.date === pday && t.entryTime)) {
        u.push({ what: `パークの開園時刻（${pday}）`, why: '最初の区間に何件入るか計算できない' });
      }
      if (!ph.close && !LAYOUT.closeDefault && !parkLeave(pday)) {
        u.push({ what: `パークの閉園時刻（${pday}）`, why: '最後の区間に何件入るか計算できない' });
      }
    }
    bookings('2000-01-01').filter(b => b.state === '未定').forEach(b => {
      u.push({ what: `${b.label}の解禁日`, why: '基準日が未定のため逆算できない' });
    });
    /* 重複除去 */
    const seen = new Set();
    return u.filter(x => !seen.has(x.what) && seen.add(x.what));
  }

  /* ── F6. パーク内の回り順（コース） ──
     ★これは「候補を出す」機能ではない。時間指定・昼寝・帰りの締切を動かせない固定点として置き、
     その隙間ごとに「歩く分を引いたら何件入らないか」を出す＝引き算のまま順序だけを決める。
     待ち時間は当日次第なので推定しない。仮定値（既定45分）を明示したうえで件数だけ数える。
     地理データ（環状の順序と徒歩分）は data/park-layout.<park>.json から configure() で入る。 */
  const num = (v, d) => (typeof v === 'number' && isFinite(v) && v > 0) ? v : d;
  const NORM = s => (g.DandoriParser ? g.DandoriParser.norm(String(s || '')) : String(s || ''));
  const ring = () => (LAYOUT && Array.isArray(LAYOUT.ring)) ? LAYOUT.ring : [];
  const ringOf = area => ring().find(r => r.area === area) || null;
  const ringIdx = area => ring().findIndex(r => r.area === area);

  /* 環に沿って from→to を一方向に歩く。from===to は「一周」になる（step=±1） */
  function arc(from, to, step) {
    const R = ring();
    const i = ringIdx(from), j = ringIdx(to);
    if (i < 0 || j < 0) return { min: 0, path: [from, to].filter(Boolean), unknown: true };
    const path = [];
    let m = 0, k = i;
    do {
      path.push(R[k].area);
      m += step > 0 ? (R[k].toNextMin || 0) : (R[(k - 1 + R.length) % R.length].toNextMin || 0);
      k = (k + step + R.length) % R.length;
    } while (k !== j);
    path.push(R[j].area);
    return { min: m, path };
  }

  /* 環状なので双方向に歩ける。短いほうを返す（経路上のエリアは通りがかりに寄れる） */
  function walk(from, to) {
    const i = ringIdx(from), j = ringIdx(to);
    /* 環に無いエリア（データ未整備）は距離を作らない。順序だけ通す */
    if (i < 0 || j < 0) return { min: 0, path: [...new Set([from, to].filter(Boolean))], unknown: true };
    if (i === j) return { min: 0, path: [from] };
    const f = arc(from, to, 1), b = arc(from, to, -1);
    return f.min <= b.min ? f : b;
  }

  /* 遠回り（from===to なら一周）。同じ分数なら「乗れるものが早く出てくる向き」を取る */
  function sweep(from, to, rideable) {
    if (ringIdx(from) < 0 || ringIdx(to) < 0) return walk(from, to);
    const f = arc(from, to, 1), b = arc(from, to, -1);
    if (f.min !== b.min) return f.min > b.min ? f : b;
    const firstHit = p => {
      const k = p.findIndex(area => ATTRACTIONS.some(a => a.area === area && rideable(a)));
      return k < 0 ? 99 : k;
    };
    return firstHit(f.path) <= firstHit(b.path) ? f : b;
  }
  const loopMin = () => ring().reduce((s, r) => s + (r.toNextMin || 0), 0);
  /* 環に沿って i から j へ順方向に進む分数（i===j は一周ではなく0） */
  function fwdMin(i, j) {
    const R = ring();
    let m = 0;
    for (let k = i; k !== j; k = (k + 1) % R.length) m += R[k].toNextMin || 0;
    return m;
  }

  /* エリア入場枠（例「スーパー・ニンテンドー・ワールド」）はアトラクションではないので
     マスタに当たらない。別名でエリアへ寄せる */
  function areaEntryOf(name) {
    const n = NORM(name);
    const hit = ring().find(r => (r.names || []).some(x => n.includes(NORM(x))));
    if (hit) return hit.area;
    const exact = ring().find(r => n.includes(NORM(r.area)));
    return exact ? exact.area : null;
  }

  /* 誰が乗れるか。all=子ども全員○ / some=一部○ / switch=子どもは全員×だが大人は○ / none=誰も乗れない */
  function rideClass(a) {
    const kids = STATE.people.filter(p => !p.adult);
    const adults = STATE.people.filter(p => p.adult);
    const adultOk = adults.some(p => judge(p, a).s === 'ok');
    if (!kids.length) return adultOk ? 'all' : 'none';
    const ok = kids.filter(p => judge(p, a).s === 'ok');
    if (ok.length === kids.length) return 'all';
    if (ok.length) return 'some';
    return adultOk ? 'switch' : 'none';
  }
  const cantRide = a => STATE.people.filter(p => !p.adult && judge(p, a).s !== 'ok').map(p => p.name);

  /* パーク日：時間指定を持つ券の日 > 券の日 > 旅行開始日 */
  function parkDays() {
    const d = (STATE.tickets || []).map(t => t.date).filter(Boolean);
    return [...new Set(d)].sort();
  }
  function parkDay() {
    const fixed = (STATE.tickets || [])
      .filter(t => t.date && (t.fixed || t.slots || []).some(s => s.at)).map(t => t.date).sort();
    return fixed[0] || parkDays()[0] || STATE.trip.start || null;
  }

  /* 画面が「通りたくないエリア」を並べるための一覧（環の順） */
  const areas = () => ring().map(r => r.area);

  /* 期間中に出るもの（ゾンビ等）。避けるかどうかを決めるのは利用者なので、ここは候補を返すだけ */
  function hazards(day) {
    const hs = (LAYOUT && LAYOUT.hazards) || [];
    if (!day) return hs;
    return hs.filter(h => !h.season || (day >= h.season.from && day <= h.season.to));
  }

  function course(opts) {
    opts = opts || {};
    if (!ring().length) return null;
    const day = opts.day || parkDay();
    const ph = STATE.parkHours || {};
    const wait = num(opts.waitMin, num(ph.waitMin, num(LAYOUT.assumeWaitMin, DEFAULT_WAIT)));
    const entrance = LAYOUT.entrance || ring()[0].area;
    const warns = [];

    /* ── 通りたくないエリア（例：ホラー・ナイトのゾンビ）──
       時間帯つきの通行止めとして扱う。環状なので反対回りで避けられることが多い。
       避けられない場合は「避けられない」と出す（黙って通す道を引かない） */
    const avoids = (STATE.constraints || [])
      .filter(c => c.type === 'avoid' && (c.areas || []).length);
    function avoidAt(area, from, to) {
      return avoids.find(c => {
        if (c.areas.indexOf(area) < 0) return false;
        if (from == null || to == null) return true;   // 時刻が不明なら「かかりうる」側に倒す
        const a = c.from ? toMin(c.from) : 0;
        const b = c.to ? toMin(c.to) : 24 * 60;
        return from < b && a < to;
      });
    }
    const blockedOn = (path, from, to) =>
      [...new Set(path)].filter(area => avoidAt(area, from, to));

    /* 固定点1：券の時間指定。エリア入場枠の中にライドの枠が入れ子になる形なので、重なりは1ブロックに畳む */
    const slots = [];
    (STATE.tickets || []).filter(t => !t.date || t.date === day).forEach(t => {
      (t.fixed || t.slots || []).forEach(s => {
        if (!s.at) return;
        const a = s.ride ? ATTRACTIONS.find(x => x.id === s.ride) : matchAttraction(s.name);
        slots.push({ at: s.at, until: s.until || null, name: s.name, ticket: t.name,
          area: a ? a.area : areaEntryOf(s.name), attraction: a, reentry: s.reentry });
      });
    });
    slots.sort((x, y) => toMin(x.at) - toMin(y.at) ||
      (toMin(y.until || y.at) - toMin(x.until || x.at)));

    const blocks = [];
    slots.forEach(s => {
      const end = toMin(s.until || s.at);
      const last = blocks[blocks.length - 1];
      if (last && toMin(s.at) < last.end) {
        last.end = Math.max(last.end, end);
        last.until = toStr(last.end);
        last.items.push(s);
        if (!last.area) last.area = s.area;
        if (s.reentry === false) last.reentry = false;
        if (!s.until) last.openEnd = true;
      } else {
        blocks.push({ kind: 'fixed', start: toMin(s.at), end, at: s.at, until: s.until,
          area: s.area, items: [s], reentry: s.reentry === false ? false : null, openEnd: !s.until });
      }
    });
    /* 固定点2：昼寝。エリアは動かない（休むだけ）が、時間は確実に消える */
    (STATE.constraints || []).filter(c => c.type === 'nap').forEach(c => {
      blocks.push({ kind: 'nap', start: toMin(c.from), end: toMin(c.to),
        at: c.from, until: c.to, area: null, label: c.label, items: [] });
    });
    blocks.sort((a, b) => a.start - b.start || a.end - b.end);

    /* 開園・閉園。閉園は「帰りの便からの退園締切」があればそちらが勝つ（早いほうが締切） */
    const entry = (STATE.tickets || []).find(t => t.date === day && t.entryTime);
    const open = ph.open || (entry && entry.entryTime) || LAYOUT.openDefault || null;
    const leave = parkLeave(day);
    const manualClose = ph.close || LAYOUT.closeDefault || null;
    let close = null, closeSrc = null;
    if (leave && manualClose) {
      close = toMin(leave) <= toMin(manualClose) ? leave : manualClose;
      closeSrc = close === leave ? 'departure' : (ph.close ? 'manual' : 'default');
    } else if (leave) { close = leave; closeSrc = 'departure'; }
    else if (manualClose) { close = manualClose; closeSrc = ph.close ? 'manual' : 'default'; }

    const steps = [];
    const used = new Set();
    blocks.forEach(b => b.items.forEach(s => { if (s.attraction) used.add(s.attraction.id); }));

    let pos = entrance;
    let cur = open ? toMin(open) : null;
    let walked = 0;    // 実際に歩く分（遠回りを選んだぶんを含む）
    let forced = 0;    // 固定点の順序が強いる最短の移動分（往復のムダはここで測る）
    const visited = [entrance];
    steps.push({ kind: 'open', at: open, area: entrance,
      b: '入園', e: open ? (ph.open ? '入力した開園時刻' : entry ? '券の入場時間' : '開園時刻は既定値（要確認）') : '開園時刻が未入力' });

    function emitWindow(to, target, isLast) {
      const span = (cur != null && to != null) ? to - cur : null;
      const free = a => !used.has(a.id) && rideClass(a) !== 'none';
      const gain = p => ATTRACTIONS.filter(a => p.indexOf(a.area) >= 0 && free(a)).length;
      const capOf = m => (span == null ? null : Math.max(0, Math.floor((span - m) / wait)));

      /* 直行が既定。ただし
         (a) 動く必要がない区間（次の固定点が同じエリア／最後の出口戻り）は一周が「回り順」そのもの
         (b) 直行だけでは窓が埋まらない（候補 < 入る件数）ときだけ遠回りに広げる
         ——時間が余っていないのに候補を増やすために歩くのは、引き算の逆なのでやらない */
      let w = target ? walk(pos, target) : { min: 0, path: [pos] };
      forced += w.min;
      /* 通りたくないエリアを跨がない向きがあるなら、遠回りでもそちらを取る */
      let detour = 0;
      if (target && pos !== target && avoids.length && blockedOn(w.path, cur, to).length) {
        const clean = [arc(pos, target, 1), arc(pos, target, -1)]
          .filter(x => !blockedOn(x.path, cur, to).length).sort((x, y) => x.min - y.min)[0];
        if (clean) { detour = clean.min - w.min; w = clean; }
      }
      if (target && ring().length) {
        const long = sweep(pos, target, free);
        const fits = span == null ? (pos === target) : (span - long.min) >= wait;
        const need = pos === target || (capOf(w.min) != null && capOf(w.min) > gain(w.path));
        const clean = !blockedOn(long.path, cur, to).length;
        if (long.min > w.min && fits && need && clean && gain(long.path) > gain(w.path)) w = long;
      }
      const blocked = blockedOn(w.path, cur, to);
      const rest = span != null ? span - w.min : null;
      const cap = capOf(w.min);
      const items = [], dropped = [];
      w.path.forEach(area => ATTRACTIONS.filter(a => a.area === area).forEach(a => {
        if (used.has(a.id)) return;
        used.add(a.id);
        const av = avoidAt(area, cur, to);
        if (av) { dropped.push({ id: a.id, name: a.name, short: a.short, area, why: av.label || '通りたくないエリア' }); return; }
        const cls = rideClass(a);
        if (cls === 'none') { dropped.push({ id: a.id, name: a.name, short: a.short, area, why: '全員×' }); return; }
        items.push({ id: a.id, name: a.name, short: a.short, area, cls, ng: cantRide(a) });
      }));
      const step = { kind: 'move', at: cur != null ? toStr(cur) : null, until: to != null ? toStr(to) : null,
        from: pos, to: target || pos, path: w.path, walkMin: w.min, spanMin: span, restMin: rest,
        capacity: cap, items, dropped, isLast: !!isLast, detour, blocked,
        over: cap != null && items.length > cap, short: rest != null && rest < 0 };
      steps.push(step);
      walked += w.min;
      if (target) { pos = target; if (visited[visited.length - 1] !== target) visited.push(target); }
      if (to != null) cur = to;
      return step;
    }

    blocks.forEach(b => {
      if (cur != null && b.start > cur) emitWindow(b.start, b.area || pos, false);
      else if (cur == null) emitWindow(b.start, b.area || pos, false);
      if (b.kind === 'fixed') {
        steps.push({ kind: 'fixed', at: b.at, until: b.until, area: b.area, reentry: b.reentry,
          openEnd: b.openEnd, items: b.items.map(s => ({ name: s.name, ticket: s.ticket })) });
        if (b.area) { pos = b.area; if (visited[visited.length - 1] !== b.area) visited.push(b.area); }
      } else {
        steps.push({ kind: 'nap', at: b.at, until: b.until, label: b.label });
      }
      cur = Math.max(cur == null ? b.end : cur, b.end);
    });

    /* 最後の区間：出口（入口エリア）へ戻る分も歩く時間として引く */
    emitWindow(close ? toMin(close) : null, entrance, true);
    steps.push({ kind: 'exit', at: close, area: entrance, b: 'パークを出る',
      e: closeSrc === 'departure' ? '帰りの便から逆算した退園の締切'
        : closeSrc === 'manual' ? '入力した閉園時刻'
        : closeSrc === 'default' ? '閉園時刻は既定値（要確認）' : '閉園・退園の締切が未入力' });

    /* ── 破綻の検出（回り順に固有のもの） ── */
    steps.filter(s => s.kind === 'move').forEach(s => {
      if (s.short) {
        warns.push({ lv: 'warn', kind: 'window',
          ti: `${s.at}–${s.until} は移動だけで足りません`,
          dt: `${s.path.join('→')} は徒歩${s.walkMin}分。この区間は${s.spanMin}分しかないので、${-s.restMin}分たりません。`,
          fix: '時間指定を取り直すか、間のエリアを捨てて直行する前提に切り替える。' });
      } else if (s.over) {
        warns.push({ lv: 'note', kind: 'capacity',
          ti: `${s.at}–${s.until} に入るのは${s.capacity}件（候補${s.items.length}件）`,
          dt: `${s.spanMin}分から徒歩${s.walkMin}分を引いて実質${s.restMin}分。待ち${wait}分と置くと${s.capacity}件が上限です。`,
          fix: `先に${s.capacity}件を選び、残りは捨てる前提で並べる（${s.items.slice(0, 4).map(i => i.short).join('・')}…）。` });
      }
    });
    /* 時間はあるのに回る先が無い区間。避けた結果そうなることがあるので、黙って空欄にしない */
    steps.filter(s => s.kind === 'move' && s.capacity > 0 && !s.items.length).forEach(s => {
      const why = s.dropped.length
        ? `通り道の${s.dropped.map(d => d.short).join('・')}は対象外です（${[...new Set(s.dropped.map(d => d.why))].join('・')}）。`
        : '通り道のアトラクションは、この日すでに別の区間へ割り当て済みです。';
      warns.push({ lv: 'note', kind: 'emptyWindow',
        ti: `${s.at}–${s.until} は回る先がありません（${s.capacity}件ぶんの時間が空く）`,
        dt: `${s.path.join('→')} を歩く想定ですが、${why}`,
        fix: avoids.length
          ? '避ける範囲を見直すか、この時間は再訪（もう一度乗る）・ショー・食事に充てる。早めに切り上げる判断もここで。'
          : 'この時間は再訪（もう一度乗る）・ショー・食事に充てる。早めに切り上げる判断もここで。' });
    });

    /* 通りたくないエリア：避けられたか、避けられなかったかを必ず言う */
    steps.filter(s => s.kind === 'move').forEach(s => {
      if (s.blocked && s.blocked.length) {
        const av = avoidAt(s.blocked[0], s.at ? toMin(s.at) : null, s.until ? toMin(s.until) : null);
        const label = (av && av.label) || '通りたくないエリア';
        warns.push({ lv: 'warn', kind: 'avoid',
          ti: `${s.blocked.join('・')} を通らずに行けません（${label}）`,
          dt: `${s.at || '?'}–${s.until || '?'} の移動 ${s.path.join('→')} は、この時間帯に避けたいエリアを通ります。`
            + (s.isLast ? `出口は${entrance}なので、閉園前に出るなら必ず通ります。` : `反対回りにしても ${s.to} へは届きません。`),
          fix: s.isLast
            ? `${av && av.from ? av.from : 'その時間'}より前に出るか、通る前提で支度する（子どもを抱っこ・前を歩く・イヤーマフ）。`
            : `この区間の時間指定を取り直すか、${s.to} 側を捨てて手前で折り返す。` });
      } else if (s.detour > 0) {
        warns.push({ lv: 'note', kind: 'detour',
          ti: `${s.at}–${s.until} は +${s.detour}分の遠回りで避けています`,
          dt: `${s.path.join('→')}（徒歩${s.walkMin}分）。短い向きは避けたいエリアを通るので、反対回りにしました。`,
          fix: '遠回りぶんは実質時間から引いてあります。件数が足りなければ、この区間で回る先を減らす。' });
      }
    });
    steps.filter(s => s.kind === 'fixed' && s.area).forEach(s => {
      const av = avoidAt(s.area, toMin(s.at), toMin(s.until || s.at));
      if (!av) return;
      warns.push({ lv: 'warn', kind: 'avoidFixed',
        ti: `時間指定が ${s.area} にあります（${av.label || '避けたいエリア'}）`,
        dt: `${s.at}${s.until ? '–' + s.until : '〜'} の ${s.items.map(i => i.name).join('／')} は、避けたい時間帯・エリアと重なります。`,
        fix: '枠を取り直せるなら早い時間へ。取り直せないなら、この枠を捨てるか通る前提で支度する。' });
    });

    /* エリア入場整理券：時間指定の枠で押さえていないゲート付きエリアは、当日取れないと丸ごと消える */
    const gateAreas = [...new Set(steps.flatMap(s => s.kind === 'move' ? s.path : (s.area ? [s.area] : [])))]
      .map(ringOf).filter(r => r && r.gate);
    const covered = new Set(steps.filter(s => s.kind === 'fixed' && s.area).map(s => s.area));
    gateAreas.filter(r => !covered.has(r.area)).forEach(r => {
      warns.push({ lv: 'warn', kind: 'gate',
        ti: `${r.area}エリアは整理券が要る場合があります`,
        dt: `${r.gateNote || 'エリア入場に整理券が必要になる場合があります。'} 時間指定の券で押さえていないため、取れなければこの区間はまるごと消えます。`,
        fix: '入園直後にアプリで取得を試す。取れなかったときに回る先（同じ区間の別エリア）を先に決めておく。' });
    });
    /* 行ったり来たり：時間指定の順序が強いる移動と、一周で回った場合の下限との差 */
    if (visited.length > 2) {
      const full = loopMin();
      const idx = [...new Set(visited.map(ringIdx))].filter(i => i >= 0).sort((a, b) => a - b);
      /* 円周上の点を全部通る閉路の下限は「一周」と「いちばん広い隙間を除いた区間の往復」の小さいほう */
      let gap = 0;
      idx.forEach((v, k) => { gap = Math.max(gap, fwdMin(v, idx[(k + 1) % idx.length])); });
      const minTour = Math.min(full, 2 * (full - gap));
      /* 比較するのは「固定点が強いる最短移動」と「同じエリアを一周で回った場合」。
         時間が余っていて自分から遠回りしたぶん（sweep）は往復のムダではないので数えない */
      const extra = forced - minTour;
      if (extra >= 10) {
        warns.push({ lv: 'note', kind: 'backtrack',
          ti: `時間指定の順序で ${extra}分ぶん往復します`,
          dt: `いまの並びだと必要な移動は最短でも合計${forced}分。同じエリアを一周で回れば${minTour}分で足ります（差 ${extra}分）。`,
          fix: '時間指定を取り直せるなら、エリアの並び順（' + ring().map(r => r.area).join('→') + '）に沿う時刻へ寄せる。' });
      }
    }
    if (!close) {
      warns.push({ lv: 'note', kind: 'closeUnknown', ti: '閉園（退園）の時刻が未入力です',
        dt: '最後の区間に何件入るかを計算できません。',
        fix: '当日の閉園時刻を入れる。帰りの便を貼れば退園の締切から自動で入ります。' });
    }
    if (!open) {
      warns.push({ lv: 'note', kind: 'openUnknown', ti: '開園（入園）の時刻が未入力です',
        dt: '最初の区間に何件入るかを計算できません。', fix: '当日の開園時刻か、券の入場時間を入れる。' });
    }

    return { day, open, close, closeSrc, assumeWait: wait, entrance,
      avoids, hazards: hazards(day),
      walkMin: walked, forcedWalkMin: forced, steps, warns,
      approx: !LAYOUT.verifiedAt };
  }

  g.DandoriSolver = {
    EDGE_CM, configure, emptyState, emptyTrip, migrateState, judge, effectiveMin, verdictCounts, matchAttraction,
    solve, derive, bookings, overlaps, undecided, shift, isoDate, toMin, toStr,
    course, walk, rideClass, parkDay, parkDays, parkLeave, hazards, areas,
  };
})(typeof window !== 'undefined' ? window : globalThis);
