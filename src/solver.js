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
  let EXPOSURE = null;   /* pro: 屋外率テーブル（雨の Finding 用） */
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
    if (opts.exposure) EXPOSURE = opts.exposure;
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

  /* ★公式の休止情報に載っているものは「乗れるもの」として扱わない。
     判定・回り順から外すだけで ATTRACTIONS からは消さない（券の突合には残す必要がある）。
     再開すれば data 側の closed を外すだけで戻る */
  function open_() { return ATTRACTIONS.filter(a => !a.closed); }

  function verdictCounts(p) {
    const c = { ok: 0, edge: 0, ng: 0, unknown: 0 };
    open_().forEach(a => { c[judge(p, a).s]++; });
    return c;
  }

  /* チケットの対象アトラクション名をマスタへ突合する（正規化済み前提） */
  function matchAttraction(name) {
    const n = g.DandoriParser ? g.DandoriParser.norm(name) : name;
    return ATTRACTIONS.find(a =>
      (g.DandoriParser ? g.DandoriParser.norm(a.name) : a.name) === n ||
      a.short === n || a.id === n) || null;
  }

  /* ── pro 専用: 雨の Finding（屋外率テーブル exposure.usj.json を使う） ──
     公開リポの回り順エンジンを取り込んだ際に、pro 側だけにあったこの機能を移植した。
     公開側の parkDays() は日付の配列を返すため、Map を返す旧実装は ticketsByDate() に改名した */
  const mdOf = iso => { const p = iso.split('-'); return `${+p[1]}/${+p[2]}`; };

  const fmtMin = n => n >= 60
    ? (n % 60 ? `${Math.floor(n / 60)}時間${n % 60}分` : `${n / 60}時間`)
    : `${n}分`;

  /* 入場日ごとに券をまとめる。date が無い券は「パーク日が不明」なので捨てる（推測しない） */
  function ticketsByDate() {
    const m = new Map();
    (STATE.tickets || []).forEach(t => {
      if (!t.date) return;
      if (!m.has(t.date)) m.set(t.date, []);
      m.get(t.date).push(t);
    });
    return m;
  }

  /* 券の対象アトラクションから area を引く。fixed/slots は ride か名前、free は名前だけ */
  function areasOf(tickets) {
    const out = [];
    tickets.forEach(t => {
      const named = [...(t.fixed || t.slots || []), ...(t.free || []).map(n => ({ name: n }))];
      named.forEach(s => {
        const a = s.ride ? ATTRACTIONS.find(x => x.id === s.ride) : matchAttraction(s.name);
        if (a && a.area) out.push(a.area);
      });
    });
    return [...new Set(out)];
  }

  /* null のエリアは平均から外し、外したことを partial で持ち帰る（黙って 0 にしない） */
  function outdoorRatioOf(areas) {
    const table = (EXPOSURE && EXPOSURE.areas) || {};
    const vals = [];
    let missing = 0;
    areas.forEach(a => {
      const v = table[a];
      if (typeof v === 'number') vals.push(v); else missing++;
    });
    if (!vals.length) return { ratio: null, partial: missing > 0 };
    return { ratio: vals.reduce((s, x) => s + x, 0) / vals.length, partial: missing > 0 };
  }

  /* 帰りの便までの脚。mode が無い脚は推測せず合計から外し、外したことを partial で持ち帰る */
  function returnOutdoorMin() {
    const d = STATE.constraints.find(c => c.type === 'departure');
    if (!d || !Array.isArray(d.legs) || !d.legs.length) return null;
    const table = (EXPOSURE && EXPOSURE.legModes) || {};
    let min = 0, known = 0, unknown = 0;
    d.legs.forEach(l => {
      const r = l.mode ? table[l.mode] : undefined;
      if (typeof r === 'number') { min += (l.min || 0) * r; known++; } else unknown++;
    });
    return known ? { min: Math.round(min), partial: unknown > 0 } : null;
  }

  function rainFindings() {
    const out = [];
    const ret = returnOutdoorMin();
    const retDate = STATE.trip && STATE.trip.end;
    if (ret && ret.min > 0 && retDate && !ticketsByDate().has(retDate)) {
      out.push({
        lv: 'note', kind: 'rain',
        ti: `帰りの日 ${mdOf(retDate)} で屋外なのは ${fmtMin(ret.min)} です`,
        /* partial のとき「濡れるのはこの分だけです」は言えない。除外がある時点で
           完全性を断言できないため、集計対象を限定した表現に切り替える（C2） */
        dt: ret.partial
          ? '種別が分かっている区間だけの集計です。種別が未設定の区間は含めていません。'
          : '移動の大半は屋内か車内で、濡れるのはこの分だけです。',
        fix: '折りたたみ1本を手荷物に。人数分は要りません。',
      });
    }
    const days = [...ticketsByDate().entries()].map(function (e) {
      return { date: e[0], tickets: e[1] };
    });
    if (!days.length) return out;
    /* 推定屋外分数の降順。算出できない日は後ろへ。同順は日付順（設計 §どの日を warn にするか）
       r・stay は sort 用に一度だけ算出し、map 側はここでスタッシュした値を読むだけにする
       （他に days の変異は入らないので、forEach→sort→map の間で古くなる心配は無い） */
    days.forEach(d => {
      const r = outdoorRatioOf(areasOf(d.tickets));
      const stay = d.tickets.map(t => t.stayHours).find(h => typeof h === 'number');
      d._ratio = r;
      d._stay = stay;
      d._min = (r.ratio !== null && typeof stay === 'number') ? stay * 60 * r.ratio : null;
    });
    days.sort((a, b) => {
      if ((a._min === null) !== (b._min === null)) return a._min === null ? 1 : -1;
      if (a._min !== null && a._min !== b._min) return b._min - a._min;
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });

    const single = days.length === 1;
    return days.map((d, i) => {
      const r = d._ratio;
      const stay = d._stay;
      const outdoorMin = d._min === null ? null : Math.round(d._min);
      const verified = !!(EXPOSURE && EXPOSURE._verified);

      const head = single
        ? `雨の日に気をつけるのは ${mdOf(d.date)} です`
        : (i === 0
            ? `雨の日に一番壊れるのは ${mdOf(d.date)} です`
            : `${mdOf(d.date)} も屋外中心の日です`);

      let dt = 'パーク日。待機列と移動が屋外中心で、傘は待機列で使えません。';
      if (outdoorMin !== null) {
        dt += ` 滞在${stay}時間のうち屋外はおよそ${fmtMin(outdoorMin)}`
          + `（屋外率${r.ratio.toFixed(2)}${verified ? '' : '・未検証の推定値'}）。`;
      }
      if (r.partial) {
        dt += outdoorMin === null
          ? ' 屋外率が未設定のエリアがあるため、時間の見積もりは出していません。'
          : ' 屋外率が未設定のエリアは、この見積もりに含めていません。';
      }

      return {
        lv: i === 0 ? 'warn' : 'note',
        kind: 'rain', ti: head, dt,
        fix: 'レインコートを人数分。ベビーカーにはレインカバー。傘は当てにしない。',
      };
    }).concat(out);
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
            /* ★「ホテルで休憩」と書けるのは、パークへ戻れるときだけ。
               USJは年間パス以外は再入場できない＝出たらその日は終わり。券種を見て文面を変える */
            f.push({ lv: 'note', kind: 'adjacent', ti: '昼寝は指定枠の直後に置けます',
              dt: `${s.name}（${s.at}〜${s.until}・再入場不可）を終えてから ${c.label} に入る形なら衝突しません。`,
              fix: `午前は下の子向け → ${s.at} に指定枠 → ${s.until} から休憩、の順に固定。`
                + (canReenter() ? '' : ' ただしパークを出ると同じ券では戻れないので、休憩はパーク内でとるか、出るならこれを最後の予定にする。') });
          }
        });
      }
    }));

    /* ★B0. 休止中（公式の休止情報）が券の対象や「行きたい」に入っていたら黙って消さない。
       open_() で判定・回り順からは外してあるので、ここで出さないと理由ごと消える。
       身長の話ではないので deadSlot や wantMiss には混ぜない */
    const closedHit = new Map();
    STATE.tickets.forEach(t => {
      [...(t.free || []), ...(t.fixed || t.slots || []).map(x => x.name)]
        .map(n => n && matchAttraction(n)).forEach(a => { if (a && a.closed) closedHit.set(a.id, a); });
      (t.fixed || t.slots || []).forEach(x => {
        const a = x.ride && ATTRACTIONS.find(y => y.id === x.ride);
        if (a && a.closed) closedHit.set(a.id, a);
      });
    });
    (STATE.constraints || []).filter(c => c.type === 'want').forEach(c => {
      (c.rides || []).forEach(id => {
        const a = ATTRACTIONS.find(y => y.id === id);
        if (a && a.closed) closedHit.set(a.id, a);
      });
    });
    if (closedHit.size) {
      const list = [...closedHit.values()];
      f.push({ lv: 'warn', kind: 'closedRide', ti: '休止中のアトラクションが入っています',
        dt: `${list.map(a => a.name).join('、')} は公式が休止中と告知しています。`
          + `${list.map(a => a.closedNote).filter(Boolean).join(' ')} 当日は乗れないので、この枠は数えていません。`,
        fix: '別のものに置き換える。来園前に公式の「ショー＆アトラクション休止情報」で再開していないか確認する。' });
    }

    /* B. 券のムダ枠（F2）。無駄と断定せず子どもスイッチを併記する */
    STATE.tickets.forEach(t => {
      const freeNames = (t.free || []);
      const dead = freeNames.map(matchAttraction)
        .filter(a => a && !a.closed && kids.length && !kids.some(p => judge(p, a).s === 'ok'));
      if (dead.length) {
        f.push({ lv: 'note', kind: 'deadSlot', ti: '子どもが使えない枠が含まれています',
          dt: `${t.name} の対象のうち ${dead.map(a => a.name).join('、')} は、いまの身長だと子どもは全員乗れません。`,
          fix: '大人が交代で乗れば無駄になりません（子どもスイッチ）。券を選び直す段階なら、この枠がない構成が安い。' });
      }
      const used = (t.fixed || t.slots || []).map(s => s.ride ? ATTRACTIONS.find(a => a.id === s.ride) : matchAttraction(s.name))
        .filter(a => a && !a.closed && kids.some(p => judge(p, a).s === 'ok'));
      if (used.length) {
        f.push({ lv: 'good', kind: 'usable', ti: '時間指定の枠は子どもが乗れます',
          dt: `${[...new Set(used.map(a => a.name))].join('、')} は現在の身長で条件を満たしています。` });
      }
    });

    /* C. 身長の境界（F1）。当日は靴込みで計測される */
    kids.forEach(p => {
      if (p.h === null || p.h === undefined) return;
      const near = open_().filter(a => judge(p, a).s === 'edge');
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

    return f.concat(rainFindings());
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
    /* 昼寝の場所は「パークを出るか」＝再入場できるかの分岐。年間パス以外は出たら戻れない */
    if (canReenter() === false) {
      STATE.constraints.filter(c => c.type === 'nap' && !c.where).forEach(c => {
        u.push({ what: `${c.label || '昼寝'}の場所（パーク内か、一度出るか）`,
          why: 'いまの券では出ると戻れない。どちらかで組み方が変わる' });
      });
    }
    if (STATE.hotel && !STATE.hotel.checkIn) u.push({ what: '宿のチェックイン日', why: '解禁監視・逆算に必要' });
    STATE.tickets.forEach(t => { if (!t.date) u.push({ what: `${t.name}の入場日`, why: '時間指定の衝突検査に必要' }); });
    /* pro 専用: 雨の見積もりに要る2つ。滞在時間と、帰りの日の区間が屋内か屋外か */
    STATE.tickets.forEach(t => {
      if (t.date && t.stayHours == null)
        u.push({ what: `${t.name}の滞在時間`, why: '屋外にいる時間を見積もれない' });
    });
    const depLegs = (STATE.constraints.find(c => c.type === 'departure') || {}).legs;
    if (Array.isArray(depLegs) && depLegs.some(l => !l.mode))
      u.push({ what: '帰りの日の区間の種別', why: '屋内か屋外かが決まらず濡れる時間を出せない' });
    /* パーク当日の開園・閉園（F6の区間計算に必要。閉園は帰りの便から逆算できれば不要） */
    const pday = parkDay();
    if (ring().length && pday) {
      const ph = parkHoursFor(pday);
      if (!ph.open && !dayInfo(pday).some(x => x.entryTime)) {
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
      const k = p.findIndex(area => open_().some(a => a.area === area && rideable(a)));
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

  /* ★1.5デイ・2デイ券は「入場日」だけでは日が足りない。券名から使える日を展開する。
     1.5デイ＝初日は入場時間から（例15:00）＋翌日は終日。2デイ＝2日とも終日。
     パーサは触らない（控えに書いてあるのは入場日1つだけなので、ここで解釈する） */
  function ticketDays(t) {
    if (!t || !t.date) return [];
    const m = NORM(t.name || '').match(/([0-9]+(?:\.[0-9]+)?)\s*デイ/);
    const n = m ? Math.ceil(parseFloat(m[1])) : 1;
    const out = [];
    for (let i = 0; i < Math.max(1, Math.min(n, 5)); i++) {
      out.push({
        date: isoDate(shift(t.date, 0, i)),
        /* 初日だけ入場時間が効く（1.5デイの午後入場）。2日目以降は開園から */
        entryTime: i === 0 ? (t.entryTime || null) : null,
        nth: i + 1, of: n, ticket: t.name,
      });
    }
    return out;
  }

  /* パーク日：券から展開した日をすべて（1.5デイなら2日）。無ければ旅行開始日 */
  function parkDays() {
    const d = (STATE.tickets || []).flatMap(ticketDays).map(x => x.date);
    return [...new Set(d)].sort();
  }
  function dayInfo(day) {
    return (STATE.tickets || []).flatMap(ticketDays).filter(x => x.date === day);
  }
  /* 開園・閉園は日ごとに違う（1.5デイの初日は午後から）。byDay があればそれが勝つ */
  function parkHoursFor(day) {
    const ph = STATE.parkHours || {};
    const per = (ph.byDay && day && ph.byDay[day]) || {};
    return { open: per.open || ph.open || null, close: per.close || ph.close || null, waitMin: ph.waitMin };
  }
  function parkDay() {
    const fixed = (STATE.tickets || [])
      .filter(t => t.date && (t.fixed || t.slots || []).some(s => s.at)).map(t => t.date).sort();
    return fixed[0] || parkDays()[0] || STATE.trip.start || null;
  }

  /* 画面が「通りたくないエリア」を並べるための一覧（環の順） */
  const areas = () => ring().map(r => r.area);

  /* ★パークの再入場（券種の話）。エリア入場整理券の「再入場不可」とは別物。
     USJは年間パス以外は再入場できない＝一度出たらその日は戻れない。
     データが無いパークでは「分からない」= null を返し、断定しない */
  function canReenter() {
    const r = LAYOUT && LAYOUT.reentry;
    if (!r) return null;
    if (r.allowed === true) return true;
    if (!r.annualPassOnly) return false;
    const pat = new RegExp(r.passPattern || '年間パス|年パス', 'i');
    return (STATE.tickets || []).some(t => pat.test(t.name || ''));
  }

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
    const ph = parkHoursFor(day);
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
        at: c.from, until: c.to, area: null, label: c.label, where: c.where || null, items: [] });
    });
    blocks.sort((a, b) => a.start - b.start || a.end - b.end);

    /* 開園・閉園。閉園は「帰りの便からの退園締切」があればそちらが勝つ（早いほうが締切） */
    const entry = dayInfo(day).find(x => x.entryTime);
    const open = ph.open || (entry && entry.entryTime) || LAYOUT.openDefault || null;
    const leave = parkLeave(day);
    const manualClose = ph.close || LAYOUT.closeDefault || null;
    let close = null, closeSrc = null;
    if (leave && manualClose) {
      close = toMin(leave) <= toMin(manualClose) ? leave : manualClose;
      closeSrc = close === leave ? 'departure' : (ph.close ? 'manual' : 'default');
    } else if (leave) { close = leave; closeSrc = 'departure'; }
    else if (manualClose) { close = manualClose; closeSrc = ph.close ? 'manual' : 'default'; }

    /* 行きたいアトラクション。候補を増やす指定ではなく「外せないもの」の宣言として扱い、
       入らない／通らない／乗れないなら破綻として出す */
    const wantIds = new Set((STATE.constraints || [])
      .filter(c => c.type === 'want').flatMap(c => c.rides || []));
    const wants = [...wantIds].map(id => ATTRACTIONS.find(a => a.id === id)).filter(Boolean);

    /* ★その日のパーク時間の外にある固定点は落とす。
       1.5デイの初日は15:00入園なので、13:30の昼寝は「入園前」＝パークを出た話ではない */
    const openMin = open ? toMin(open) : null;
    const closeMin = close ? toMin(close) : null;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (openMin != null && b.end <= openMin) { blocks.splice(i, 1); continue; }
      if (closeMin != null && b.start >= closeMin) { blocks.splice(i, 1); continue; }
      b.preEntry = openMin != null && b.start < openMin;   // 開園をまたぐ＝入園前から続いている
    }

    const steps = [];
    /* 前の日に回るぶんは候補から外す（1.5デイ等で2日に分けるとき、同じものを二重に数えない） */
    const used = new Set(opts.exclude ? [...opts.exclude] : []);
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
      const gain = p => open_().filter(a => p.indexOf(a.area) >= 0 && free(a)).length;
      const gainWant = p => open_().filter(a =>
        p.indexOf(a.area) >= 0 && free(a) && wantIds.has(a.id) && !avoidAt(a.area, cur, to)).length;
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
        /* 行きたいものが反対側にあるなら、窓が埋まっていても遠回りする（希望が優先） */
        const forWant = gainWant(long.path) > gainWant(w.path) && capOf(long.min) > 0;
        if (long.min > w.min && fits && clean && (forWant || (need && gain(long.path) > gain(w.path)))) w = long;
      }
      const blocked = blockedOn(w.path, cur, to);
      const rest = span != null ? span - w.min : null;
      const cap = capOf(w.min);
      const items = [], dropped = [];
      w.path.forEach(area => open_().filter(a => a.area === area).forEach(a => {
        if (used.has(a.id)) return;
        used.add(a.id);
        const av = avoidAt(area, cur, to);
        if (av) { dropped.push({ id: a.id, name: a.name, short: a.short, area, why: av.label || '通りたくないエリア' }); return; }
        const cls = rideClass(a);
        if (cls === 'none') { dropped.push({ id: a.id, name: a.name, short: a.short, area, why: '全員×', want: wantIds.has(a.id) }); return; }
        items.push({ id: a.id, name: a.name, short: a.short, area, cls, ng: cantRide(a),
          want: wantIds.has(a.id), indoor: !!a.indoor, soaks: !!a.soaks });
      }));
      /* 行きたいものを先に並べる。入る件数を超えたとき、上から順に取れば希望が残る */
      items.sort((x, y) => (y.want ? 1 : 0) - (x.want ? 1 : 0));
      const wantN = items.filter(i => i.want).length;
      const step = { kind: 'move', at: cur != null ? toStr(cur) : null, until: to != null ? toStr(to) : null,
        from: pos, to: target || pos, path: w.path, walkMin: w.min, spanMin: span, restMin: rest,
        capacity: cap, items, dropped, isLast: !!isLast, detour, blocked, wantN,
        over: cap != null && items.length > cap, short: rest != null && rest < 0,
        wantOver: cap != null && wantN > cap };
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
          openEnd: b.openEnd, items: b.items.map(s => ({ name: s.name, ticket: s.ticket,
            ride: s.attraction ? s.attraction.id : null, want: !!(s.attraction && wantIds.has(s.attraction.id)) })) });
        if (b.area) { pos = b.area; if (visited[visited.length - 1] !== b.area) visited.push(b.area); }
      } else {
        steps.push({ kind: 'nap', at: b.at, until: b.until, label: b.label, where: b.where, preEntry: b.preEntry });
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
    /* ── 行きたいアトラクションの行き先判定 ──
       「入る／入らない」を1件ずつ確定させる。入らないものは理由と、寄るのに要る分を出す */
    const moves = steps.filter(s => s.kind === 'move');
    function insertCost(area) {
      /* いまの並びのどこかへ寄り道するとして、いちばん安い区間と余分にかかる分 */
      let best = null;
      moves.forEach(s => {
        if (avoidAt(area, s.at ? toMin(s.at) : null, s.until ? toMin(s.until) : null)) return;
        const extra = walk(s.from, area).min + walk(area, s.to).min - s.walkMin;
        if (!best || extra < best.extra) best = { extra, step: s };
      });
      return best;
    }
    const wantStatus = wants.map(a => {
      const fixedAt = steps.find(s => s.kind === 'fixed' && s.items.some(i => i.ride === a.id));
      if (fixedAt) return { id: a.id, name: a.name, short: a.short, area: a.area, state: 'fixed', at: fixedAt.at, until: fixedAt.until };
      const cls = rideClass(a);
      if (cls === 'none') return { id: a.id, name: a.name, short: a.short, area: a.area, state: 'cantRide' };
      const drop = moves.find(s => s.dropped.some(d => d.id === a.id));
      if (drop) {
        const why = drop.dropped.find(d => d.id === a.id).why;
        return { id: a.id, name: a.name, short: a.short, area: a.area, state: 'dropped', why, at: drop.at, until: drop.until };
      }
      const hit = moves.find(s => s.items.some(i => i.id === a.id));
      if (hit) {
        /* 入る件数を超えている区間では、どれが残るかを勝手に決めない（順位は利用者が付ける） */
        return { id: a.id, name: a.name, short: a.short, area: a.area, cls,
          state: hit.wantOver ? 'tight' : 'planned',
          at: hit.at, until: hit.until, capacity: hit.capacity, wantN: hit.wantN };
      }
      /* 経路に出てこない理由が「避けたいエリアだから」なら、そう言う（通れないのではなく避けている） */
      const av = avoids.find(c => c.areas.indexOf(a.area) >= 0);
      const ins = insertCost(a.area);
      if (av && !ins) return { id: a.id, name: a.name, short: a.short, area: a.area, cls, state: 'dropped', why: av.label || '通りたくないエリア' };
      return { id: a.id, name: a.name, short: a.short, area: a.area, cls, state: 'unreachable', insert: ins };
    });

    /* 複数日をまとめて組むとき（plan）は、希望の警告は日ごとに出さず最後に1回だけ出す */
    if (opts.wantWarns !== false) wantWarnings();
    function wantWarnings() {
    wantStatus.filter(w => w.state === 'cantRide').forEach(w => warns.push({
      lv: 'warn', kind: 'wantCantRide', ti: `行きたい ${w.short} は誰も乗れません`,
      dt: `${w.name}（${w.area}）は、いまの身長だと家族の誰も条件を満たしません。`,
      fix: '身長が届く人がいないので、この1件は行き先から外す。境界（あと数cm）なら02の判定を確認。' }));
    wantStatus.filter(w => w.state === 'dropped').forEach(w => warns.push({
      lv: 'warn', kind: 'wantDropped', ti: `行きたい ${w.short} は回れません（${w.why}）`,
      dt: `${w.name}（${w.area}）は ${w.at || '?'}–${w.until || '?'} の区間で対象から外れています。`,
      fix: w.why === '全員×' ? '大人が交代で乗る（子どもスイッチ）か、行き先から外す。'
        : '避ける時間帯・エリアを見直すか、その時間帯より前に回る順へ組み替える。' }));
    wantStatus.filter(w => w.cls === 'switch').forEach(w => warns.push({
      lv: 'note', kind: 'wantSwitch', ti: `行きたい ${w.short} は子どもが全員乗れません`,
      dt: `${w.name}（${w.area}）は身長が足りず、乗れるのは大人だけです。`,
      fix: '大人が交代で乗る（子どもスイッチ）。待ち時間はその間ぶん増えるので、区間の件数から1件減らして考える。' }));
    wantStatus.filter(w => w.state === 'unreachable').forEach(w => warns.push({
      lv: 'warn', kind: 'wantUnreachable', ti: `行きたい ${w.short} は今の並びだと通りません`,
      dt: `${w.name}は${w.area}エリア。時間指定と昼寝から決まる回り順に、このエリアが入っていません。`,
      fix: w.insert
        ? `${w.insert.step.at}–${w.insert.step.until} の区間に寄せると +${w.insert.extra}分（その区間の実質は${w.insert.step.restMin != null ? w.insert.step.restMin + '分' : '未計算'}）。入らなければ時間指定を取り直すか、この1件を捨てる。`
        : '寄れる区間がありません。時間指定を取り直すか、この1件を捨てる。' }));
    moves.filter(s => s.wantOver).forEach(s => warns.push({
      lv: 'warn', kind: 'wantOver',
      ti: `${s.at}–${s.until} は行きたい${s.wantN}件のうち${s.capacity}件しか入りません`,
      dt: `実質${s.restMin}分。待ち${wait}分と置くと${s.capacity}件が上限です（${s.items.filter(i => i.want).map(i => i.short).join('・')}）。`,
      fix: '先に順位をつけて、入らないぶんは捨てるか別の日へ回す。待ちが短い時間帯（開園直後・パレード中）に寄せるのも手。' }));
    }

    /* ★パークを出て休むなら、戻れるかを先に出す。
       USJは年間パス以外は再入場できない＝昼寝でホテルへ帰ると、その日はそこで終わり。
       「昼寝の後にまだ予定がある」形になっていたら、それは組めない旅程になる */
    const reenter = canReenter();
    if (reenter === false) {
      steps.forEach((s, i) => {
        /* 入園前から続いている休憩は「出た」話ではないので対象外 */
        if (s.kind !== 'nap' || s.where === 'inpark' || s.preEntry) return;
        /* 判断材料は「出たあとにパーク時間がどれだけ残るか」。
           やることが残っているかではなく、買った時間を捨てることになるかで見る */
        const rest = (closeMin != null && s.until) ? closeMin - toMin(s.until) : null;
        const after = steps.slice(i + 1).filter(x =>
          x.kind === 'fixed' || (x.kind === 'move' && x.items.length));
        if (rest == null || rest <= 0) {
          if (s.where === 'out') warns.push({ lv: 'note', kind: 'reentryLast',
            ti: `${s.at} にパークを出ると、その日はそこで終わりです`,
            dt: `${s.label || '休憩'}でパークを出ると、いまの券では戻れません（再入場は年間パスのみ）。`,
            fix: '出る前に、その日にやることを終わらせておく。' });
          return;
        }
        warns.push({ lv: 'warn', kind: 'reentry',
          ti: `${s.at}–${s.until} にパークを出ると戻れません`,
          dt: `${s.label || '休憩'}のあと、パークは${close}まで（残り${Math.floor(rest / 60)}時間${rest % 60 ? (rest % 60) + '分' : ''}）あります`
            + (after.length ? `。予定も${after.length}件残っています` : '（回る先は残っていません）')
            + `。いまの券では再入場できません${(LAYOUT.reentry && LAYOUT.reentry.note) ? `（${LAYOUT.reentry.note}）` : ''}。`,
          fix: 'パーク内で休む（ベビーカー・屋内の休憩スペース・レストラン）か、この休憩を最後にして残り時間を捨てる。'
            + ((LAYOUT.reentry && LAYOUT.reentry.exceptions || []).length ? ` 例外：${LAYOUT.reentry.exceptions.join('／')}。` : '') });
      });
    }

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
      avoids, hazards: hazards(day), wants: wantStatus, reentry: reenter,
      walkMin: walked, forcedWalkMin: forced, steps, warns,
      approx: !LAYOUT.verifiedAt };
  }

  /* ── F6b. 複数日をまとめて組む（1.5デイ・2デイ券）──
     日ごとに course() を回し、前の日に回るぶんを次の日から差し引く。
     希望（行きたい）は日をまたいで1回だけ判定する＝「初日に入らなくても2日目に入るならOK」 */
  const WANT_RANK = { fixed: 0, planned: 1, tight: 2, dropped: 3, unreachable: 4, cantRide: 5 };

  function plan(opts) {
    opts = opts || {};
    if (!ring().length) return null;
    const days = parkDays();
    if (!days.length) {
      const only = course(opts);
      return only ? { days: [only], wants: only.wants, warns: [], multi: false } : null;
    }
    const out = [];
    /* どの日であれ時間指定で乗るものは、他の日の候補に出さない（二重に数えない） */
    const done = new Set();
    (STATE.tickets || []).forEach(t => (t.fixed || t.slots || []).forEach(s => {
      const a = s.ride ? ATTRACTIONS.find(x => x.id === s.ride) : matchAttraction(s.name);
      if (a) done.add(a.id);
    }));
    days.forEach((d, i) => {
      const c = course({ day: d, waitMin: opts.waitMin, exclude: done, wantWarns: false });
      if (!c) return;
      c.nth = i + 1;
      c.of = days.length;
      c.info = dayInfo(d);
      /* 「入る件数」までを回るぶんとして次の日から外す。入らなかったものは翌日へ残す */
      c.steps.forEach(s => {
        if (s.kind === 'fixed') s.items.forEach(x => { if (x.ride) done.add(x.ride); });
        if (s.kind === 'move') s.items.slice(0, s.capacity == null ? s.items.length : s.capacity)
          .forEach(x => done.add(x.id));
      });
      out.push(c);
    });
    if (!out.length) return null;

    /* 希望：日をまたいでいちばん良い結果を採る */
    const byId = {};
    out.forEach(c => c.wants.forEach(w => {
      const cur = byId[w.id];
      if (!cur || WANT_RANK[w.state] < WANT_RANK[cur.state]) byId[w.id] = { ...w, day: c.day, nth: c.nth };
    }));
    const wants = Object.values(byId);
    const warns = [];
    const okw = wants.filter(w => w.state === 'fixed' || w.state === 'planned');
    if (wants.length) {
      const perDay = out.map(c => `${c.nth}日目 ${wants.filter(w => w.nth === c.nth && (w.state === 'fixed' || w.state === 'planned')).length}件`);
      warns.push({ lv: okw.length === wants.length ? 'good' : 'note', kind: 'wantSummary',
        ti: `行きたい${wants.length}件のうち、入るのは${okw.length}件`,
        dt: `${perDay.join('／')}。${okw.length < wants.length ? `残り${wants.length - okw.length}件は入りません。` : '全部入ります。'}`,
        fix: okw.length < wants.length ? '下の理由を見て、捨てるか・日を入れ替えるか・時間指定を取り直すかを決める。' : '' });
    }
    wants.filter(w => w.state !== 'fixed' && w.state !== 'planned').forEach(w => {
      const from = out.find(c => c.nth === w.nth);
      const src = (from && from.warns.filter(x => x.kind && x.kind.indexOf('want') === 0)) || [];
      const hit = src.find(x => x.ti.indexOf(w.short) >= 0);
      warns.push(hit ? { ...hit, ti: `${w.nth}日目：${hit.ti}` } : {
        lv: 'warn', kind: 'wantMiss', ti: `行きたい ${w.short} は2日とも入りません`,
        dt: `${w.name}（${w.area}）は、どの日の区間にも収まりません。`, fix: '捨てるか、券を足す。' });
    });
    return { days: out, wants, warns, multi: days.length > 1 };
  }

  g.DandoriSolver = {
    EDGE_CM, configure, emptyState, emptyTrip, migrateState, judge, effectiveMin, verdictCounts, matchAttraction,
    solve, derive, bookings, overlaps, undecided, shift, isoDate, toMin, toStr,
    course, plan, walk, rideClass, parkDay, parkDays, parkLeave, hazards, areas,
    ticketDays, dayInfo, parkHoursFor, canReenter,
  };
})(typeof window !== 'undefined' ? window : globalThis);
