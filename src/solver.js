/* 段取りたび — 制約ソルバー
   コアAPI（CLAUDE.md §3・変更禁止）:
     judge(person, attraction) -> { s:'ok'|'edge'|'ng', gap:cm }
     solve()                   -> Finding[]
     derive()                  -> Step[]
     bookings(today)           -> Booking[]
   データは configure() で注入する（①はHTML埋め込み、テストは data/*.json 直読み）。 */
(function (g) {
  'use strict';

  const EDGE_CM = 5;

  let ATTRACTIONS = [];
  let RULES = [];
  let STATE = emptyState();

  /* schemaVersion 2: 交通手段を trainDate/flightDate 決め打ちから transports に一般化。
     往復新幹線・往復飛行機・車も表せる。leg: outbound(行き)|return(帰り) */
  function emptyState() {
    return {
      schemaVersion: 2,
      trip: { start: null, end: null, transports: [] },
      people: [],
      constraints: [],
      tickets: [],
      hotel: null,
      flight: null,
      train: null,
      booked: {},
    };
  }

  /* v1 の trip.json（trainDate/flightDate 形式）を v2 に移行する */
  function migrateState(s) {
    if (!s || s.schemaVersion === 2) return s;
    if (s.schemaVersion !== 1) return null;
    const t = s.trip || {};
    const transports = [];
    if (t.trainDate) transports.push({ leg: 'outbound', mode: 'train', date: t.trainDate });
    if (t.flightDate) transports.push({ leg: 'return', mode: 'flight', date: t.flightDate });
    return { ...s, schemaVersion: 2, trip: { start: t.start || null, end: t.end || null, transports } };
  }

  function configure(opts) {
    if (opts.attractions) ATTRACTIONS = opts.attractions;
    if (opts.rules) RULES = opts.rules;
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

  /* ── F2〜F5. 破綻検出 ── */
  function solve() {
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
        let t = toMin(dep.at);
        const legs = dep.legs || [];
        const idxMove = legs.findIndex(l => /バス|移動|リムジン/.test(l.name));
        for (let i = 0; i <= (idxMove < 0 ? legs.length - 1 : idxMove); i++) t -= legs[i].min;
        busLeave = toStr(t);
        deadline = toStr(t - fb.extraMinutes);
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
        const key = r.id + (tg.leg && targets.length > 1 ? '@' + tg.leg : '');
        const done = !!STATE.booked[key];
        const state =
          r.mode === 'none' ? '予約不可' :
          done ? '済' :
          (needsDate && !base) ? '未定' :
          r.mode === 'unknown' ? '監視中' :
          (days !== null && days < 0) ? '期限切れ' : '未';
        out.push({
          ...r, when, days, done, key,
          label: r.label + (tg.leg && targets.length > 1 ? `（${LEG_LABEL[tg.leg]}）` : ''),
          iso: when ? isoDate(when) : null,
          state,
        });
      });
    });
    return out.sort((a, b) => {
      const rank = x => x.state === '未' ? 0 : x.state === '監視中' ? 1 : x.state === '未定' ? 2 :
                        x.state === '予約不可' ? 3 : x.state === '済' ? 4 : 5;
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
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
    bookings('2000-01-01').filter(b => b.state === '未定').forEach(b => {
      u.push({ what: `${b.label}の解禁日`, why: '基準日が未定のため逆算できない' });
    });
    /* 重複除去 */
    const seen = new Set();
    return u.filter(x => !seen.has(x.what) && seen.add(x.what));
  }

  g.DandoriSolver = {
    EDGE_CM, configure, emptyState, migrateState, judge, effectiveMin, verdictCounts, matchAttraction,
    solve, derive, bookings, overlaps, undecided, shift, isoDate, toMin, toStr,
  };
})(typeof window !== 'undefined' ? window : globalThis);
