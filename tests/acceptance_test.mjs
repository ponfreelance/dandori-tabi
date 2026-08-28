// 受け入れ基準（.design/REQUIREMENTS.md §6）の自動検証
// 実行: node tests/acceptance_test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['src/parser.js', 'src/solver.js']) {
  vm.runInThisContext(readFileSync(join(root, f), 'utf8'), { filename: f });
}
const P = globalThis.DandoriParser;
const S = globalThis.DandoriSolver;

const attractions = JSON.parse(readFileSync(join(root, 'data/attractions.usj.json'), 'utf8')).attractions;
const rules = JSON.parse(readFileSync(join(root, 'data/booking-rules.json'), 'utf8')).rules;
const layout = JSON.parse(readFileSync(join(root, 'data/park-layout.usj.json'), 'utf8'));
const exposure = JSON.parse(readFileSync(join(root, 'data/exposure.usj.json'), 'utf8'));

// ── fixtures（実物の構造・表記ゆれを保った加工値。parse_test.py と同一） ──
const SAMPLES = {
  A_flight: `旅程1

2026年11月17日（火）　JAL876便

大阪(伊丹)15:35発\t\t東京(羽田)17:00着

座席：クラス J 座席番号：21A.21C.21D.21H`,

  B_usj: `1.5デイ・スタジオ・パス　大人
入場日\t2026年11月15日 (日)
入場時間\t15:00
チケット番号\tP:9012.0.261003.00811
ユニバーサル・エクスプレス・パス 5 ～アドベンチャースペシャル～
入場日\t2026年11月16日 (月)
チケット番号\tP:9012.0.261003.00812
対象アトラクション／ショー（時間指定あり）
11:30～ スーパー・ニンテンドー・ワールド™ (再入場不可)
11:30～ 12:00 マリオカート ～クッパの挑戦状～™
12:00～ 12:30 ヨッシー・アドベンチャー™
対象アトラクション／ショー（時間指定なし）
ハリウッド・ドリーム・ザ・ライド
ミニオン・ハチャメチャ・ライド
ザ・フライング・ダイナソー`,

  C_hotel: `ホテル ポートサイド ガーデン
ファミリー ワンダールーム
シェフこだわりの朝食ビュッフェ付プラン
日程・人数
2026/11/15(日)〜2026/11/17(火)
大人2名, 子供3名, 1室`,
};

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  OK  ' + name); };

// 1. 3件すべてスキーマに落ちる（種別自動判別つき）
const flight = P.parseAny(SAMPLES.A_flight);
const park = P.parseAny(SAMPLES.B_usj);
const hotel = P.parseAny(SAMPLES.C_hotel);
ok('3件すべてパース成功', () => {
  assert.equal(flight.type, 'flight');
  assert.equal(park.type, 'parkTickets');
  assert.equal(hotel.type, 'hotel');
  assert.equal(flight.flightNo, 'JAL876');     // 3文字コードが化けない
  assert.equal(flight.date, '2026-11-17');
  assert.equal(hotel.checkIn, '2026-11-15');
  assert.equal(hotel.checkOut, '2026-11-17');
  assert.equal(park.tickets.length, 2);
});

// 2. アトラクション名の突合 6/6
const MASTER = ['マリオカート ～クッパの挑戦状～', 'ヨッシー・アドベンチャー',
  'ハリウッド・ドリーム・ザ・ライド', 'ミニオン・ハチャメチャ・ライド',
  'ザ・フライング・ダイナソー', 'スーパー・ニンテンドー・ワールド'].map(P.norm);
ok('アトラクション名の突合 6/6', () => {
  const got = park.tickets.flatMap(t => [...t.fixed.map(f => f.name), ...t.free]);
  assert.equal(got.length, 6);
  got.forEach(g_ => assert.ok(MASTER.includes(g_), `MISS: ${g_}`));
});

// 3. reentry:false を捕捉する
ok('reentry:false を捕捉', () => {
  const s = park.tickets[1].fixed.find(f => f.name.includes('ニンテンドー'));
  assert.equal(s.reentry, false);
  assert.equal(s.at, '11:30');
});

// 4. プラン名から dinner:false を推論する
ok('朝食付プラン → dinner:false', () => {
  assert.equal(hotel.meals.breakfast, true);
  assert.equal(hotel.meals.dinner, false);
});

// ── ソルバーを実データで構成 ──
const state = S.emptyTrip();
state.trip = { start: '2026-11-15', end: '2026-11-17', transports: [
  { leg: 'outbound', mode: 'train', date: '2026-11-15' },
  { leg: 'return', mode: 'flight', date: '2026-11-17' },
] };
state.people = [
  { id: 'p1', name: '父', age: 42, h: 172, adult: true },
  { id: 'p2', name: '母', age: 36, h: 158, adult: true },
  { id: 'p3', name: '第1子', age: 7, h: 120, adult: false },
  { id: 'p4', name: '第2子', age: 4, h: 102, adult: false },
  { id: 'p5', name: '第3子', age: 1, h: 78, adult: false },
];
state.constraints = [
  { type: 'nap', who: 'p5', from: '13:30', to: '15:30', label: '第3子(1歳)の昼寝' },
  { type: 'departure', at: '15:35', flight: 'JAL876', airport: '伊丹',
    legs: [{ name: '保安検査・搭乗手続き', min: 60 }, { name: 'リムジンバス USJ→伊丹', min: 40 }, { name: '乗り場で待つ余裕', min: 30 }] },
];
state.flight = flight;   // JAL876 → ANAのルールは適用外になる
state.tickets = park.tickets.map(t => ({ ...t, until1330: null }));
// エクスプレス券の再入場不可枠は 13:30 まで（実例と同構造）
state.tickets[1].fixed.find(f => f.reentry === false).until = '13:30';
S.configure({ attractions, rules, layout, state });

// 5. 身長判定（公式2026-08-29再検証値・2値モデル）
//    大人同伴が前提の家族では minHeightWithAdult で判定する。
//    トロッコは同伴107cm（旧データの122は単独値）→ 7歳120cmは ○7/△1/×2 になる
//    件数は data/attractions.usj.json の件数に依存する（2026-08-29 再検証で 22→24件）。
//    ただし closed:true（公式の休止情報）は数えないので、判定対象は 24-2=22件
ok('7歳120cm（大人同伴）→ ○19/△1/×2', () => {
  const c = S.verdictCounts(state.people[2]);
  assert.deepEqual([c.ok, c.edge, c.ng], [19, 1, 2]);
  // △はフォービドゥンのみ（同伴122cm）＝「あと2cm」で1つ反転する。
  // スペース・ファンタジーは公式再検証で同伴102cmと判明したため△から外れた
  const edge = attractions.filter(a => !a.closed && S.judge(state.people[2], a).s === 'edge').map(a => a.id);
  assert.deepEqual(edge.sort(), ['fj']);
});
ok('7歳122cm（大人同伴）→ ○20/△0/×2', () => {
  const c = S.verdictCounts({ ...state.people[2], h: 122 });
  assert.deepEqual([c.ok, c.edge, c.ng], [20, 0, 2]);
});
ok('7歳100cm（大人同伴）→ ○15/△1/×6', () => {
  const c = S.verdictCounts({ ...state.people[2], h: 100 });
  assert.deepEqual([c.ok, c.edge, c.ng], [15, 1, 6]);
});
ok('★1歳78cm でも10件ある（ワンダーランドとショーを数えるようになった）', () => {
  const c = S.verdictCounts(state.people[4]);
  assert.deepEqual([c.ok, c.edge, c.ng], [10, 0, 12]);
  // ただし「1人で安定して座れること」が条件のものが含まれる＝データ上○でも実際は要確認
  const seat = attractions.filter(a => !a.closed && S.judge(state.people[4], a).s === 'ok' && /座/.test(a.notes || ''));
  assert.ok(seat.length >= 2, '着座条件つきが含まれる: ' + seat.map(a => a.short).join('・'));
});
// 5b. 休止中（公式の休止情報に載っている closed:true）は「乗れるもの」として数えない。
//     判定から外すだけで配列からは消さない＝データには公式の休止事実が残る
ok('★休止中は判定に数えない（closed を落とすと件数が増える）', () => {
  const closed = attractions.filter(a => a.closed);
  assert.ok(closed.length >= 1, 'データに休止中が1件以上ある: ' + closed.map(a => a.id).join(','));
  const c = S.verdictCounts(state.people[0]);          // 父172cm＝身長では全部○になる
  assert.equal(c.ok + c.edge + c.ng, attractions.length - closed.length);
  const open = attractions.filter(a => !a.closed);
  S.configure({ attractions: open, rules, layout, state });
  assert.deepEqual(S.verdictCounts(state.people[0]), c, '休止中を配列から外しても結果は同じ');
  S.configure({ attractions, rules, layout, state });
});
ok('★休止中は回り順の候補にも出さない', () => {
  const ids = S.course().steps.flatMap(s => (s.items || []).map(i => i.id))
    .concat(S.course().steps.flatMap(s => (s.dropped || []).map(i => i.id)));
  attractions.filter(a => a.closed).forEach(a => {
    assert.ok(!ids.includes(a.id), a.id + ' は休止中なので回り順に出さない');
  });
});
ok('★休止中はあと何cmの案内にも出さない', () => {
  const t = { ...state, people: [{ id: 'a', name: '父', h: 172, adult: true },
    { id: 'k', name: '子', age: 7, h: 99, adult: false }] };   // 102cmの space に あと3cm で届く
  S.configure({ attractions, rules, layout, state: t });
  const edge = S.solve().filter(f => f.kind === 'edge');
  edge.forEach(f => assert.ok(!/スペース・ファンタジー/.test(f.dt), '休止中を「あと3cm」で薦めない: ' + f.dt));
  S.configure({ attractions, rules, layout, state });
});

// 5c. 休止中を黙って消さない。券の対象や「行きたい」に入っていたら破綻として出す
const closedRide = attractions.find(a => a.closed);
ok('★券の対象に休止中が入っていたら出す', () => {
  const t = { ...state, tickets: [{ name: 'エクスプレス・パス テスト', date: '2026-11-16',
    fixed: [], free: ['ハリウッド・ドリーム・ザ・ライド', closedRide.name] }] };
  S.configure({ attractions, rules, layout, state: t });
  const c = S.solve().filter(x => x.kind === 'closedRide');
  assert.equal(c.length, 1);
  assert.ok(c[0].dt.includes(closedRide.name), c[0].dt);
  assert.equal(c[0].lv, 'warn');
  // 「子どもが乗れない枠」として二重に出さない（理由が違う）
  const dead = S.solve().filter(x => x.kind === 'deadSlot');
  dead.forEach(d => assert.ok(!d.dt.includes(closedRide.name), '休止中を身長のせいにしない: ' + d.dt));
  S.configure({ attractions, rules, layout, state });
});
ok('★行きたいものが休止中なら出す（区間に入らないのではなく休止）', () => {
  const t = { ...state, tickets: [], constraints: [{ type: 'want', rides: [closedRide.id, 'kart'] }] };
  S.configure({ attractions, rules, layout, state: t });
  const c = S.solve().filter(x => x.kind === 'closedRide');
  assert.equal(c.length, 1);
  assert.ok(c[0].dt.includes(closedRide.name), c[0].dt);
  S.configure({ attractions, rules, layout, state });
});
ok('★休止中が絡まなければ出さない', () => {
  assert.equal(S.solve().filter(x => x.kind === 'closedRide').length, 0);
});

ok('単独利用（大人なし）は122cm基準になる', () => {
  const solo = S.emptyTrip();
  solo.people = [{ id: 'k', name: '子', age: 10, h: 120, adult: false }];
  S.configure({ attractions, rules, layout, state: solo });
  const kart = attractions.find(a => a.id === 'kart');
  assert.deepEqual(S.judge(solo.people[0], kart), { s: 'edge', gap: 2 });
  S.configure({ attractions, rules, layout, state });
});
ok('上限身長（ダイナソー198cm超）と同伴時制限なし（ジョーズ×1歳）', () => {
  const fd = attractions.find(a => a.id === 'fd');
  assert.equal(S.judge({ h: 199, adult: true }, fd).s, 'ng');
  const jaws = attractions.find(a => a.id === 'jaws');
  assert.equal(S.judge(state.people[4], jaws).s, 'ok'); // 78cmでも同伴なら制限なし
});

// 6. 1ヶ月前が 8/20（8/21ではない）
ok('暦月逆算 9/20 → 8/20', () => {
  assert.equal(S.isoDate(S.shift('2026-09-20', -1, 0)), '2026-08-20');
  assert.notEqual(S.isoDate(S.shift('2026-09-20', 0, -30)), '2026-08-20'); // -30日は別物
});

// 7. none × singlePoint で代替経路が生成される
ok('none×singlePoint → 代替経路＋切替デッドライン', () => {
  const spof = S.solve().filter(f => f.kind === 'singlePoint');
  assert.equal(spof.length, 1);
  assert.ok(spof[0].fix.includes('JR経由'), '代替経路を含む');
  assert.equal(spof[0].deadline, '13:20'); // 15:35-60(検査)-40(バス)=13:55 が通常最終 → +35分差で13:20判断
});

// 追加検証: 昼寝と再入場不可の近接（実データでは接触せず直後に置ける）
ok('再入場不可×昼寝 → 直後に置ける提案', () => {
  const adj = S.solve().filter(f => f.kind === 'adjacent');
  assert.equal(adj.length, 1);
});

// 追加検証: ムダ枠（ハリドリ・ダイナソー132cmは子ども全員不可）
ok('ムダ枠検出（子どもスイッチ併記）', () => {
  const dead = S.solve().filter(f => f.kind === 'deadSlot');
  assert.equal(dead.length, 1);
  assert.ok(dead[0].fix.includes('子どもスイッチ'));
});

// 追加検証: 予約カレンダー（JR解禁 = 乗車1ヶ月前 2026-10-15 10:00）
ok('予約カレンダー逆算', () => {
  const b = S.bookings('2026-07-23');
  const jr = b.find(x => x.id === 'jr');
  assert.equal(jr.iso, '2026-10-15');
  assert.equal(jr.at, '10:00');
  const limo = b.find(x => x.id === 'limobus');
  assert.equal(limo.state, '予約不可');    // 「不要」と表示しない
  const hotelRule = b.find(x => x.id === 'hotel');
  assert.equal(hotelRule.state, '監視中'); // unknown は監視対象
  assert.equal(b.filter(x => x.id === 'ana').length, 0, 'JAL利用ならANAルールは出さない');
});

// 追加検証: 同日の二重締切（10/15 に新幹線10:00とレストラン11:00が重なる）
ok('同日の二重締切を明示', () => {
  const ov = S.overlaps('2026-07-23');
  assert.ok(ov.some(o => o.day === '2026-10-15' && o.items.length >= 2));
});

// 追加検証: キャンセル可否の表示データと順序トラップ検出
ok('取消規定データ（USJ券=不可 / JR=可 / 宿=要確認）', () => {
  const by = id => rules.find(r => r.id === id).cancel;
  assert.equal(by('parkpass').refundable, false);
  assert.equal(by('express').refundable, false);
  assert.equal(by('jr').refundable, true);
  assert.equal(by('hotel').refundable, 'unknown');
  assert.equal(by('jal').refundable, 'partial');
});
ok('取消不可×未確定の依存 → 順序トラップ警告', () => {
  // 何も予約していない状態：パークチケット等は取消不可なのに宿・列車が未確定
  const trap = S.solve().filter(f => f.kind === 'cancelTrap');
  assert.equal(trap.length, 1);
  assert.ok(trap[0].ti.includes('パークチケット'));
  assert.ok(trap[0].dt.includes('ホテル'), '未確定の依存として宿を挙げる');
  assert.ok(trap[0].fix.includes('順序'), '行動指針を持つ');
});
ok('取消不可のものを買い終えたら順序トラップは消える', () => {
  const booked = { ...state.booked };
  state.booked = { parkpass: true, express: true };
  const trap = S.solve().filter(f => f.kind === 'cancelTrap');
  state.booked = booked;
  assert.equal(trap.length, 0);
});

ok('予算超過 → Finding（削減候補は取消可能なものだけ・金額順）', () => {
  const bt = S.emptyTrip();
  bt.budget = 100000;
  bt.hotel = { type: 'hotel', name: '宿', price: 60000, checkIn: '2026-11-15' };
  bt.train = { type: 'train', price: 30000 };
  bt.tickets = [{ name: 'ユニバーサル・エクスプレス・パス 5', price: 28000, fixed: [], free: [] },
                { name: '1.5デイ・スタジオ・パス', price: null, fixed: [], free: [] }];
  S.configure({ attractions, rules, layout, state: bt });
  const f = S.solve().filter(x => x.kind === 'budget');
  assert.equal(f.length, 1);
  assert.ok(f[0].ti.includes('118,000'), '合計');
  assert.ok(f[0].ti.includes('18,000'), '超過額');
  assert.ok(f[0].dt.includes('1件'), '金額不明を未計上として明示');
  assert.ok(f[0].dt.includes('エクスプレス'), '取消不可は削れない側に出る');
  assert.ok(f[0].fix.startsWith('削減候補'), '削減候補を出す');
  assert.ok(f[0].fix.indexOf('宿') < f[0].fix.indexOf('新幹線'), '金額降順（宿6万→新幹線3万）');
  assert.ok(!f[0].fix.includes('エクスプレス'), '取消不可は削減候補に入れない');
  S.configure({ attractions, rules, layout, state });
});
ok('予算内・予算未設定なら Finding を出さない', () => {
  const bt = S.emptyTrip();
  bt.hotel = { type: 'hotel', name: '宿', price: 60000 };
  S.configure({ attractions, rules, layout, state: bt });
  assert.equal(S.solve().filter(x => x.kind === 'budget').length, 0, '未設定');
  bt.budget = 100000;
  S.configure({ attractions, rules, layout, state: bt });
  assert.equal(S.solve().filter(x => x.kind === 'budget').length, 0, '予算内');
  S.configure({ attractions, rules, layout, state });
});

// 追加検証: 新幹線控えのパース（旧来の合成書式）
ok('新幹線控えのパース（テキスト控えの書式）', () => {
  const t = P.parseAny(`2026/11/17（火）
のぞみ42号 普通車指定席
新大阪 16:30発
東京 18:57着
座席：7号車 11A,11B,11C`);
  assert.equal(t.type, 'train');
  assert.equal(t.date, '2026-11-17');
  assert.equal(t.trainName, 'のぞみ42号');
  assert.equal(t.from, '新大阪');
  assert.equal(t.depart, '16:30');
  assert.equal(t.to, '東京');
  assert.equal(t.arrive, '18:57');
  assert.equal(t.car, 7);
  assert.deepEqual(t.seats, ['11A', '11B', '11C']);
  assert.equal(t.status, '仮');
  // 括弧書式も受ける
  const t2 = P.parseTrain('ひかり503号 東京（06:33発）→ 新大阪（09:13着）');
  assert.equal(t2.from, '東京');
  assert.equal(t2.arrive, '09:13');
});

// 追加検証: スマートEXアプリ「詳細」画面の実書式
// ※実機の控え（2026-08-15）で書式を確認し、値は加工した（日付・列車・区間・席は架空）
ok('スマートEXアプリの控えをそのまま貼れる', () => {
  const t = P.parseAny(`詳細
1234
乗車日時
2026/7/4（土） 9:03 → 11:28
区間
新横浜 → 京都
人数
おとな 2　こども 2
商品
スマート EX
運行状況
のぞみ 271
N700系16両, 全車指定席
時間
9:03 → 11:28
区間
新横浜 → 京都
座席
9号車 7番 D/E席, 8番 D/E席
普通車`);
  assert.equal(t.type, 'train', '種別を判別できる');
  assert.equal(t.date, '2026-07-04', '1桁の月日（2026/7/4）を読む');
  assert.equal(t.trainName, 'のぞみ271', '「号」が無い表記');
  assert.equal(t.from, '新横浜');
  assert.equal(t.to, '京都', '矢印だけの区間（発着の文字なし）');
  assert.equal(t.depart, '09:03', '1桁の時は0埋めする');
  assert.equal(t.arrive, '11:28');
  assert.equal(t.car, 9);
  // ★「7番 D/E席」は2席。畳まれた表記を展開しないと席数を取り違える
  assert.deepEqual(t.seats, ['7D', '7E', '8D', '8E']);
  assert.equal(t.adults, 2);
  assert.equal(t.children, 2);
  assert.equal(t.seats.length, t.adults + t.children, '席数と人数が一致する');
  assert.equal(t.product, 'スマートEX');
});
ok('畳まれた席表記でも、旧来の平坦な表記でも読める', () => {
  const folded = P.parseTrain('座席 3号車 12番 A/B/C席');
  assert.deepEqual(folded.seats, ['12A', '12B', '12C']);
  const flat = P.parseTrain('座席：7号車 11A,11B,11C');
  assert.deepEqual(flat.seats, ['11A', '11B', '11C']);
  assert.equal(flat.car, 7);
});

// 追加検証: 交通手段の一般化（行き=新幹線・帰り=飛行機の決め打ちを排除）
ok('往復新幹線 → JR解禁が行き・帰りの2件、飛行機系とリムジンバスは出ない', () => {
  const rt = S.emptyTrip();
  rt.trip = { start: '2026-11-15', end: '2026-11-17', transports: [
    { leg: 'outbound', mode: 'train', date: '2026-11-15' },
    { leg: 'return', mode: 'train', date: '2026-11-17' },
  ] };
  rt.people = state.people;
  S.configure({ attractions, rules, layout, state: rt });
  const b = S.bookings('2026-07-23');
  const jrs = b.filter(x => x.id === 'jr');
  assert.equal(jrs.length, 2);
  assert.deepEqual(jrs.map(x => x.iso).sort(), ['2026-10-15', '2026-10-17']);
  assert.ok(jrs.some(x => x.label.includes('行き')) && jrs.some(x => x.label.includes('帰り')));
  assert.equal(b.filter(x => x.id === 'jal').length, 0, '飛行機を使わない旅では出さない');
  assert.equal(b.filter(x => x.id === 'limobus').length, 0);
  assert.equal(S.solve().filter(f => f.kind === 'singlePoint').length, 0, '帰りが新幹線ならバスの単一障害点は出ない');
  S.configure({ attractions, rules, layout, state });
});
ok('v1 trip.json は v3 へ移行して読める', () => {
  const v1 = { schemaVersion: 1, trip: { start: '2026-11-15', end: '2026-11-17', trainDate: '2026-11-15', flightDate: '2026-11-17' }, people: [], constraints: [], tickets: [], hotel: null, flight: null, booked: {} };
  const m = S.migrateState(v1);
  assert.equal(m.schemaVersion, 3);
  assert.equal(m.trips.length, 1);
  assert.equal(m.activeTrip, m.trips[0].id);
  assert.equal(m.trips[0].budget, null);
  assert.deepEqual(m.trips[0].trip.transports, [
    { leg: 'outbound', mode: 'train', date: '2026-11-15' },
    { leg: 'return', mode: 'flight', date: '2026-11-17' },
  ]);
});
ok('v2 trip.json は v3 へ包んで移行する', () => {
  const v2 = { schemaVersion: 2, trip: { start: '2026-11-15', end: null, transports: [] },
    people: [{ id: 'p1', name: '父', age: 42, h: 172, adult: true }], constraints: [], tickets: [], hotel: null, flight: null, train: null, booked: { jr: true } };
  const m = S.migrateState(v2);
  assert.equal(m.schemaVersion, 3);
  assert.equal(m.trips[0].name, '旅行1');
  assert.equal(m.trips[0].people[0].name, '父');
  assert.deepEqual(m.trips[0].booked, { jr: true });
  assert.equal(S.migrateState(m), m, 'v3はそのまま返す');
});
ok('emptyState は v3・emptyTrip はスライス', () => {
  const f = S.emptyState();
  assert.equal(f.schemaVersion, 3);
  assert.equal(f.trips[0].id, 't1');
  const t = S.emptyTrip();
  assert.equal(t.budget, null);
  assert.equal(t.schemaVersion, undefined, 'スライスに schemaVersion は無い');
});

// 追加検証: 未定を含んだまま解ける（交通手段が未定でも例外にならない）
ok('部分入力で動く（未定は「これから決めること」へ）', () => {
  const partial = S.emptyTrip();
  partial.people = [{ id: 'k1', name: '子', age: 5, h: null, adult: false }];
  S.configure({ attractions, rules, layout, state: partial });
  const u = S.undecided();
  assert.ok(u.some(x => x.what.includes('身長')));
  assert.ok(u.some(x => x.what === '旅行日'));
  assert.doesNotThrow(() => S.solve());
  assert.doesNotThrow(() => S.bookings('2026-07-23'));
  const spof = S.solve().find(f => f.kind === 'singlePoint');
  assert.ok(spof, '帰り便未定でも単一障害点は警告する');
  assert.ok(spof.fix.includes('未定'), '判断点が出せない理由を明示');
});

ok('watchOnly ルールは①に出ない（監視②専用）', () => {
  // 実データに依存しない（公開版の booking-rules は watchOnly ルールを含まない）
  const withWatchOnly = rules.concat([{ id: 'watch-only-test', label: '監視専用テスト', anchor: 'start',
    offsetMonths: 0, offsetDays: -365, at: null, watchOnly: true, mode: 'unknown', criticality: 'replaceable' }]);
  S.configure({ attractions, rules: withWatchOnly, state });
  const b = S.bookings('2026-07-25');
  assert.equal(b.filter(x => x.id === 'watch-only-test').length, 0);
  assert.ok(b.some(x => x.id === 'hotel'), '通常の unknown ルールは出る');
  S.configure({ attractions, rules, layout, state });
});

// ── 解禁済みの窓（受付中）と締切 ──
ok('スマートEX 1年前予約：乗車1年前5:30に開き、1ヶ月前7:30に閉じる', () => {
  const r = rules.find(x => x.id === 'smartex1y');
  assert.equal(r.anchor, 'train');
  assert.equal(r.offsetMonths, -12);
  assert.equal(r.at, '05:30');
  assert.deepEqual(r.end, { offsetMonths: -1, offsetDays: 0, at: '07:30' });
  assert.ok(r.caution.includes('座席を選べません'), '席を選べない代償を持つ');
  assert.ok(r.verifiedAt && r.source, '公式の出典と検証日を持つ');
});

// 往復とも新幹線の旅行（11/15 行き・11/17 帰り）で窓の開閉を見る
const trainTrip = S.emptyTrip();
trainTrip.trip = { start: '2026-11-15', end: '2026-11-17', transports: [
  { leg: 'outbound', mode: 'train', date: '2026-11-15' },
  { leg: 'return', mode: 'train', date: '2026-11-17' },
] };
trainTrip.people = state.people;

ok('解禁日を過ぎたものは「期限切れ」ではなく「受付中」', () => {
  S.configure({ attractions, rules, layout, state: trainTrip });
  const b = S.bookings('2026-08-11');            // 旅行は 11/15〜11/17
  const y = b.filter(x => x.id === 'smartex1y');
  assert.equal(y.length, 2, '往復ぶん出る');
  assert.ok(y.every(x => x.state === '受付中'));
  assert.equal(y[0].endIso, '2026-10-15');       // 乗車1ヶ月前
  assert.equal(y[0].endAt, '07:30');
  assert.equal(y[0].endDays, 65);
  assert.equal(b.filter(x => x.state === '期限切れ').length, 0, '「期限切れ」は使わない');
  assert.equal(b[0].state, '受付中', 'いま行動できるものを先頭に出す');
  const jr = b.find(x => x.id === 'jr');
  assert.equal(jr.state, '未', '通常発売はまだ先');
});

ok('窓が閉じたら「締切」（事前申込は発売開始日7:30まで）', () => {
  const b = S.bookings('2026-10-16');            // 行きの乗車1ヶ月前(10/15)を過ぎた日
  const out = b.filter(x => x.key.endsWith('@outbound'));
  assert.equal(out.find(x => x.id === 'smartex1y').state, '締切');
  assert.equal(out.find(x => x.id === 'smartex').state, '締切');
  assert.equal(out.find(x => x.id === 'jr').state, '受付中', '通常発売は乗車日まで受付中');
  const ret = b.filter(x => x.key.endsWith('@return'));
  assert.equal(ret.find(x => x.id === 'smartex1y').state, '受付中', '帰り(11/17)の窓はまだ開いている');
});

ok('もう予約できるのに押さえていなければ Finding に出す', () => {
  const f = S.solve('2026-08-11').filter(x => x.kind === 'openNow');
  assert.equal(f.length, 1, '同じルールの往復は1件にまとめる');
  assert.ok(f[0].ti.includes('もう予約できます'));
  assert.ok(f[0].dt.includes('あと65日'), '窓が閉じるまでの日数を出す');
  assert.ok(f[0].fix.includes('取り消せる'), '取消可否で行動が変わる');
  assert.ok(f[0].fix.includes('座席を選べません'), '代償（caution）を併記する');
  assert.equal(S.solve().filter(x => x.kind === 'openNow').length, 0, 'today 無しなら日付依存の検出は飛ばす');
});

ok('予約済みにすれば受付中から消える', () => {
  trainTrip.booked = { 'smartex1y@outbound': true, 'smartex1y@return': true };
  const b = S.bookings('2026-08-11');
  assert.ok(b.filter(x => x.id === 'smartex1y').every(x => x.state === '済'));
  assert.equal(S.solve('2026-08-11').filter(x => x.kind === 'openNow').length, 0);
  trainTrip.booked = {};
  S.configure({ attractions, rules, layout, state });
});

// ── F6. パーク内の回り順 ──
S.configure({ attractions, rules, layout, state });

ok('環状の徒歩分は短いほうを取る（ハリウッド→マリオは逆回り9分）', () => {
  const w = S.walk('ハリウッド', 'マリオ');
  assert.equal(w.min, 10);   // ハリウッド→ミニオン4→ワンダーランド3→マリオ3
  assert.deepEqual(w.path, ['ハリウッド', 'ミニオン', 'ワンダーランド', 'マリオ']);
  const back = S.walk('マリオ', 'ハリウッド');
  assert.equal(back.min, 10, '逆向きも同じ');
  assert.equal(S.walk('ハリウッド', 'ハリウッド').min, 0);
});

ok('コースはエリア入場枠を固定点にし、隙間の件数を出す', () => {
  const c = S.course();
  assert.equal(c.day, '2026-11-16');            // 時間指定を持つ券の日
  // 入れ子の3枠（SNW 11:30-13:30 / マリオカート / ヨッシー）は1ブロックに畳む
  const fixed = c.steps.filter(s => s.kind === 'fixed');
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].area, 'マリオ', 'エリア入場枠の名前からエリアを解決する');
  assert.equal(fixed[0].items.length, 3);
  assert.equal(fixed[0].until, '13:30');
  const first = c.steps.find(s => s.kind === 'move');
  assert.deepEqual(first.path, ['ハリウッド', 'ミニオン', 'ワンダーランド', 'マリオ']);
  assert.equal(first.walkMin, 10);              // ワンダーランドを挟むぶん1分増える
  assert.equal(first.spanMin, 150);             // 09:00→11:30
  assert.equal(first.restMin, 140);
  assert.equal(first.capacity, 3);              // 待ち45分と置くと3件
  assert.equal(c.assumeWait, 45);
  // 時間指定で乗る2件は候補から外れ、同じエリアのトロッコは残る
  const ids = first.items.map(i => i.id);
  assert.ok(!ids.includes('kart') && !ids.includes('yoshi'), '固定点の分は二重に数えない');
  assert.ok(ids.includes('donk') && ids.includes('mini'));
  // 132cm組は子ども全員×＝大人交代（子どもスイッチ）として残す
  assert.equal(first.items.find(i => i.id === 'hd').cls, 'switch');
  assert.equal(first.items.find(i => i.id === 'mini').cls, 'some');
});

ok('昼寝は動かせない固定点として区間を割る', () => {
  const c = S.course();
  const nap = c.steps.find(s => s.kind === 'nap');
  assert.ok(nap && nap.at === '13:30' && nap.until === '15:30');
  assert.ok(c.steps.indexOf(nap) > c.steps.findIndex(s => s.kind === 'fixed'));
});

ok('閉園未入力なら件数を出さず、理由を出す（11/16は帰りの日ではない）', () => {
  const c = S.course();
  assert.equal(c.close, null);
  const last = c.steps.filter(s => s.kind === 'move').pop();
  assert.equal(last.capacity, null);
  assert.equal(last.to, 'ハリウッド', '最後は出口へ戻る分も歩く');
  assert.ok(c.warns.some(w => w.kind === 'closeUnknown'));
});

ok('帰りの日のコースは退園の締切が閉園になる', () => {
  const ret = { ...state, tickets: [{ name: '1デイ', date: '2026-11-17', fixed: [], free: [] }] };
  S.configure({ attractions, rules, layout, state: ret });
  const c = S.course();
  assert.equal(c.day, '2026-11-17');
  assert.equal(c.close, '13:55');               // 15:35 −60(保安検査) −40(バス)
  assert.equal(c.closeSrc, 'departure');
  S.configure({ attractions, rules, layout, state });
});

ok('整理券エリアを時間指定で押さえていなければ警告する', () => {
  const g = S.emptyTrip();
  g.people = state.people;
  g.tickets = [{ name: '1デイ', date: '2026-11-16', fixed: [], free: [] }];
  g.parkHours = { open: '09:00', close: '19:00', waitMin: null };
  S.configure({ attractions, rules, layout, state: g });
  const c = S.course();
  // 固定点が無い日は「一周する順」がコースになる → 途中のゲート付きエリアは全部対象
  const first = c.steps.find(s => s.kind === 'move');
  assert.equal(first.path.length, layout.ring.length + 1, '入口に戻るまでの一周');
  assert.equal(first.walkMin, 40);
  assert.equal(first.capacity, 12);              // (600−40)/45
  const gate = c.warns.filter(w => w.kind === 'gate').map(w => w.ti);
  assert.equal(gate.length, 2);
  assert.ok(gate.some(t => t.includes('マリオ')) && gate.some(t => t.includes('ハリポタ')));
  S.configure({ attractions, rules, layout, state });
});
ok('時間指定でエリアを押さえていれば整理券の警告は出ない', () => {
  assert.equal(S.course().warns.filter(w => w.kind === 'gate').length, 0);
});

ok('窓が移動時間に足りなければ破綻として出す', () => {
  const t = S.emptyTrip();
  t.people = state.people;
  t.parkHours = { open: '09:00', close: '19:00', waitMin: null };
  t.tickets = [{ name: 'テスト券', date: '2026-11-16', free: [], fixed: [
    { at: '10:00', until: '10:20', name: 'ミニオン・ハチャメチャ・ライド' },
    { at: '10:25', until: '10:45', name: 'ハリー・ポッター・アンド・ザ・フォービドゥン・ジャーニー' },
  ] }];
  S.configure({ attractions, rules, layout, state: t });
  const w = S.course().warns.filter(x => x.kind === 'window');
  assert.equal(w.length, 1);
  assert.ok(w[0].dt.includes('徒歩12分'), 'ミニオン→ワンダーランド3→マリオ3→ハリポタ6');
  assert.ok(w[0].dt.includes('7分たりません'));  // 5分の窓に12分
  S.configure({ attractions, rules, layout, state });
});

ok('時間指定の順序が往復を強いるなら移動のムダを出す', () => {
  const t = S.emptyTrip();
  t.people = state.people;
  t.parkHours = { open: '09:00', close: '19:00', waitMin: null };
  t.tickets = [{ name: 'テスト券', date: '2026-11-16', free: [], fixed: [
    { at: '10:00', until: '10:30', name: 'ハリー・ポッター・アンド・ザ・フォービドゥン・ジャーニー' },
    { at: '12:00', until: '12:30', name: 'ハリウッド・ドリーム・ザ・ライド' },
    { at: '14:00', until: '14:30', name: 'ヨッシー・アドベンチャー' },
  ] }];
  S.configure({ attractions, rules, layout, state: t });
  const b = S.course().warns.filter(x => x.kind === 'backtrack');
  assert.equal(b.length, 1);
  assert.ok(b[0].ti.includes('往復'));
  S.configure({ attractions, rules, layout, state });
});

ok('時間の余りで一周するのは「往復のムダ」に数えない', () => {
  const t = { ...state, parkHours: { open: '09:00', close: '20:00', waitMin: null } };
  S.configure({ attractions, rules, layout, state: t });
  const c = S.course();
  assert.equal(c.walkMin, 40, '実際は一周する（午後の空き時間で反対側を回る）');
  assert.equal(c.forcedWalkMin, 20, '固定点が強いるのは入口↔マリオの往復ぶんだけ');
  assert.equal(c.warns.filter(w => w.kind === 'backtrack').length, 0);
  S.configure({ attractions, rules, layout, state });
});

// ── 1.5デイ券：2日に分ける ──
const halfDayTrip = () => {
  const t = S.emptyTrip();
  t.people = state.people;
  t.tickets = [
    { name: '1.5デイ・スタジオ・パス 大人', date: '2026-11-15', entryTime: '15:00', fixed: [], free: [] },
    { name: 'ユニバーサル・エクスプレス・パス 5', date: '2026-11-16', free: [], fixed: [
      { at: '11:30', until: '13:30', name: 'スーパー・ニンテンドー・ワールド', reentry: false },
      { at: '11:30', until: '12:00', name: 'マリオカート ～クッパの挑戦状～' },
    ] },
  ];
  t.parkHours = { open: null, close: null, waitMin: null, byDay: {
    '2026-11-15': { open: null, close: '21:00' },
    '2026-11-16': { open: '09:00', close: '20:00' },
  } };
  t.constraints = [];
  return t;
};

ok('1.5デイ券は「入場日＋翌日」の2日に展開される', () => {
  const t = halfDayTrip();
  S.configure({ attractions, rules, layout, state: t });
  assert.deepEqual(S.parkDays(), ['2026-11-15', '2026-11-16']);
  const d = S.ticketDays(t.tickets[0]);
  assert.equal(d.length, 2);
  assert.equal(d[0].entryTime, '15:00', '初日は午後入場');
  assert.equal(d[1].entryTime, null, '2日目は開園から');
  assert.equal(d[1].date, '2026-11-16');
  assert.equal(S.ticketDays(t.tickets[1]).length, 1, 'エクスプレス券は1日');
  assert.equal(S.ticketDays({ name: '2デイ・スタジオ・パス', date: '2026-11-15' }).length, 2);
});

ok('plan は日ごとにルートを出し、初日の入場時間から始める', () => {
  S.configure({ attractions, rules, layout, state: halfDayTrip() });
  const p = S.plan();
  assert.equal(p.multi, true);
  assert.equal(p.days.length, 2);
  assert.equal(p.days[0].day, '2026-11-15');
  assert.equal(p.days[0].open, '15:00', '券の入場時間が初日の開園になる');
  assert.equal(p.days[0].close, '21:00');
  assert.equal(p.days[1].open, '09:00', '2日目は終日');
  assert.equal(p.days[0].nth, 1);
  assert.equal(p.days[1].of, 2);
});

ok('前の日に回るぶんは翌日の候補から外す（二重に数えない）', () => {
  S.configure({ attractions, rules, layout, state: halfDayTrip() });
  const p = S.plan();
  const idsOf = c => c.steps.filter(s => s.kind === 'move').flatMap(s => s.items.map(i => i.id));
  /* 「入る件数」までが回るぶん。そこに入ったものは翌日に出さない。
     入らなかったぶん（候補の余り）は翌日へ残す＝それが2日に分ける意味 */
  const planned = p.days[0].steps.filter(s => s.kind === 'move')
    .flatMap(s => s.items.slice(0, s.capacity == null ? s.items.length : s.capacity).map(i => i.id));
  const d2 = idsOf(p.days[1]);
  assert.ok(planned.length, '初日に回るぶんが出る');
  assert.equal(planned.filter(x => d2.includes(x)).length, 0, '初日に回るぶんは翌日に出さない');
  const leftover = idsOf(p.days[0]).filter(x => !planned.includes(x));
  assert.ok(leftover.length && leftover.every(x => d2.includes(x)), '初日に入らなかったぶんは翌日へ残る');
  // 2日目の時間指定で乗るものは、初日の候補にも出さない
  assert.ok(!idsOf(p.days[0]).includes('kart'), '翌日の時間指定ぶんは初日の候補から外す');
  assert.ok(p.days[1].steps.some(s => s.kind === 'fixed' && s.items.some(i => i.ride === 'kart')));
});

ok('希望は日をまたいで1回だけ判定する（初日に入らなくても2日目で入ればOK）', () => {
  const t = halfDayTrip();
  t.constraints = [{ type: 'want', rides: ['kart', 'jaws', 'donk'] }];
  S.configure({ attractions, rules, layout, state: t });
  const p = S.plan();
  assert.equal(p.wants.length, 3, '重複せず3件');
  assert.equal(p.wants.find(w => w.id === 'kart').state, 'fixed');
  assert.equal(p.wants.find(w => w.id === 'kart').nth, 2, '2日目の枠で確保');
  const sum = p.warns.find(w => w.kind === 'wantSummary');
  assert.ok(sum && sum.ti.includes('行きたい3件のうち'));
  assert.ok(sum.dt.includes('1日目') && sum.dt.includes('2日目'), '日ごとの内訳を出す');
});

ok('入園前に終わる昼寝は、その日の「出ると戻れない」に数えない', () => {
  const t = halfDayTrip();
  t.constraints = [{ type: 'nap', who: 'p5', from: '13:30', to: '15:30', where: 'out', label: '第3子(1歳)の昼寝' }];
  S.configure({ attractions, rules, layout, state: t });
  const p = S.plan();
  const nap1 = p.days[0].steps.find(s => s.kind === 'nap');
  assert.ok(nap1.preEntry, '15:00入園なら13:30の昼寝は入園前');
  assert.equal(p.days[0].warns.filter(w => w.kind === 'reentry').length, 0, '入園前は再入場の話ではない');
  assert.equal(p.days[1].warns.filter(w => w.kind === 'reentry').length, 1, '2日目（9:00入園）は正しく警告する');
  // 閉園後・開園前に完全に外れる固定点は落とす
  const t2 = halfDayTrip();
  t2.constraints = [{ type: 'nap', who: 'p5', from: '08:00', to: '10:00', where: 'out', label: '朝寝' }];
  t2.parkHours.byDay['2026-11-15'] = { open: '15:00', close: '21:00' };
  S.configure({ attractions, rules, layout, state: t2 });
  assert.equal(S.plan().days[0].steps.filter(s => s.kind === 'nap').length, 0, '初日のパーク時間外なので出さない');
});

ok('初日の午後だけでは入らないぶんが2日目に回る', () => {
  const t = halfDayTrip();
  t.parkHours.byDay['2026-11-15'] = { open: null, close: '17:00' };   // 15:00–17:00 の2時間
  S.configure({ attractions, rules, layout, state: t });
  const p = S.plan();
  const first = p.days[0].steps.find(s => s.kind === 'move');
  assert.ok(first.capacity <= 2, '2時間なら入るのは1〜2件');
  assert.ok(first.items.length > first.capacity, '候補のほうが多い＝捨てる判断が要る');
  const d2 = p.days[1].steps.filter(s => s.kind === 'move').flatMap(s => s.items.map(i => i.id));
  assert.ok(d2.length, '入らなかったぶんは2日目の候補に残る');
});

// ── パークの再入場（券種の話。エリア整理券の「再入場不可」とは別物） ──
const napTrip = (where, ticketName) => {
  const t = S.emptyTrip();
  t.people = state.people;
  t.parkHours = { open: '09:00', close: '20:00', waitMin: null };
  t.tickets = [{ name: ticketName || '1.5デイ・スタジオ・パス', date: '2026-11-16', free: [], fixed: [
    { at: '17:00', until: '17:30', name: 'ジョーズ' },     // 昼寝のあとに残る予定
  ] }];
  t.constraints = [{ type: 'nap', who: 'p5', from: '13:30', to: '15:30', where, label: '第3子(1歳)の昼寝' }];
  return t;
};

ok('再入場データ：年間パス以外は戻れない（未検証フラグつき）', () => {
  assert.equal(layout.reentry.allowed, false);
  assert.equal(layout.reentry.annualPassOnly, true);
  assert.equal(layout.reentry.verifiedAt, null, '公式で未検証');
  assert.ok(layout.reentry.exceptions.length >= 2, '例外（団体・年パスアップグレード等）を持つ');
});

ok('スタジオ・パスで昼寝に出ると「戻れません」', () => {
  S.configure({ attractions, rules, layout, state: napTrip('out') });
  const c = S.course();
  assert.equal(c.reentry, false);
  const w = c.warns.find(x => x.kind === 'reentry');
  assert.ok(w, '警告を出す');
  assert.ok(w.ti.includes('戻れません'));
  assert.ok(/残り\d+時間/.test(w.dt), '出たあとに捨てることになる時間を言う');
  assert.ok(w.dt.includes('件') || w.dt.includes('回る先'), '残る予定にも触れる');
  assert.ok(w.fix.includes('パーク内で休む'), '代替を出す');
  assert.ok(w.fix.includes('年間パス'), '例外も併記する');
});

ok('パーク内で休むなら警告は出ない', () => {
  S.configure({ attractions, rules, layout, state: napTrip('inpark') });
  assert.equal(S.course().warns.filter(x => x.kind === 'reentry').length, 0);
});

ok('年間パスなら再入場できる', () => {
  S.configure({ attractions, rules, layout, state: napTrip('out', 'ユニバーサル年間パス・ライト') });
  const c = S.course();
  assert.equal(c.reentry, true);
  assert.equal(c.warns.filter(x => x.kind === 'reentry').length, 0);
});

ok('出るのが最後なら「その日はそこで終わり」と出す', () => {
  const t = napTrip('out');
  t.tickets[0].fixed = [];                      // 昼寝の後に予定なし
  t.parkHours = { open: '09:00', close: '15:30', waitMin: null };
  S.configure({ attractions, rules, layout, state: t });
  const w = S.course().warns.find(x => x.kind === 'reentryLast');
  assert.ok(w && w.ti.includes('その日はそこで終わり'));
  assert.equal(S.course().warns.filter(x => x.kind === 'reentry').length, 0);
});

ok('昼寝の場所が未定なら「これから決めること」に出る', () => {
  S.configure({ attractions, rules, layout, state: napTrip(null) });
  assert.ok(S.undecided().some(x => x.what.includes('場所')));
  S.configure({ attractions, rules, layout, state: napTrip('inpark') });
  assert.ok(!S.undecided().some(x => x.what.includes('場所')));
});

ok('「ホテルで休憩」と案内しない（戻れない券のとき）', () => {
  S.configure({ attractions, rules, layout, state });
  const adj = S.solve().find(f => f.kind === 'adjacent');
  assert.ok(adj, '隣接の提案は出る');
  assert.ok(!adj.fix.includes('ホテルで休憩'), '戻れないのにホテルへ帰す案内をしない');
  assert.ok(adj.fix.includes('戻れない'), '再入場できないことを言う');
});

// ── 行きたいアトラクション ──
const wantTrip = (rides, fixed) => {
  const t = S.emptyTrip();
  t.people = state.people;
  t.parkHours = { open: '09:00', close: '19:00', waitMin: null };
  t.tickets = [{ name: 'テスト券', date: '2026-11-16', free: [], fixed: fixed || [] }];
  t.constraints = [{ type: 'want', rides }];
  return t;
};

ok('行きたいものは候補の先頭に出て、時間指定で押さえていれば「確保済み」', () => {
  const t = wantTrip(['kart', 'jaws'], [
    { at: '11:30', until: '12:00', name: 'マリオカート ～クッパの挑戦状～' },
  ]);
  S.configure({ attractions, rules, layout, state: t });
  const c = S.course();
  const kart = c.wants.find(w => w.id === 'kart');
  assert.equal(kart.state, 'fixed');
  assert.equal(kart.at, '11:30');
  const jaws = c.wants.find(w => w.id === 'jaws');
  assert.equal(jaws.state, 'planned');
  const seg = c.steps.find(s => s.kind === 'move' && s.items.some(i => i.id === 'jaws'));
  assert.equal(seg.items[0].id, 'jaws', '希望は候補の先頭に並べる');
  assert.ok(seg.items[0].want);
});

ok('行きたいものが反対側にあるなら遠回りしてでも通る', () => {
  // 入口(ハリウッド)から時計回りだとミニオン→マリオ。ジョーズ(アミティ)は反対側
  const t = wantTrip(['jaws'], [{ at: '15:00', until: '15:30', name: 'ヨッシー・アドベンチャー' }]);
  S.configure({ attractions, rules, layout, state: t });
  const first = S.course().steps.find(s => s.kind === 'move');
  assert.ok(first.path.includes('アミティ'), '希望のあるエリアを通る向きを選ぶ');
  assert.equal(first.wantN, 1);
});

ok('行きたい件数が入る件数を超えたら、どれを捨てるかを問う', () => {
  const t = wantTrip(['jaws', 'fj', 'jp']);
  t.parkHours = { open: '09:00', close: '11:00', waitMin: null };   // 2時間しかない
  S.configure({ attractions, rules, layout, state: t });
  const c = S.course();
  const w = c.warns.find(x => x.kind === 'wantOver');
  assert.ok(w, '超過を出す');
  assert.ok(w.ti.includes('行きたい3件のうち'));
  assert.ok(c.wants.every(x => x.state === 'tight'), 'どれが残るかは勝手に決めない');
  assert.ok(w.fix.includes('順位'), '順位付けを促す');
});

ok('行きたいのに誰も乗れない／子どもが乗れないを出し分ける', () => {
  const t = wantTrip(['fd']);            // ダイナソー132cm：子どもは全員×、大人は○
  S.configure({ attractions, rules, layout, state: t });
  const c = S.course();
  assert.equal(c.wants[0].cls, 'switch');
  assert.equal(c.warns.filter(x => x.kind === 'wantSwitch').length, 1);
  assert.equal(c.warns.filter(x => x.kind === 'wantCantRide').length, 0);

  const solo = wantTrip(['fd']);
  solo.people = [{ id: 'k', name: '子', age: 8, h: 120, adult: false }];   // 大人がいない
  S.configure({ attractions, rules, layout, state: solo });
  const c2 = S.course();
  assert.equal(c2.wants[0].state, 'cantRide');
  assert.ok(c2.warns.find(x => x.kind === 'wantCantRide').fix.includes('外す'));
});

ok('通らないエリアの希望は「寄ると何分か」を出す', () => {
  // 11:30-13:30 マリオに固定 → 昼寝で夕方まで潰し、閉園も早いとハリポタ側へ行けない
  const t = wantTrip(['fj'], [
    { at: '11:30', until: '13:30', name: 'スーパー・ニンテンドー・ワールド', reentry: false },
  ]);
  t.parkHours = { open: '11:00', close: '14:00', waitMin: null };
  S.configure({ attractions, rules, layout, state: t });
  const c = S.course();
  const w = c.wants[0];
  assert.equal(w.state, 'unreachable');
  assert.ok(w.insert && w.insert.extra > 0, '寄り道の追加分を出す');
  const warn = c.warns.find(x => x.kind === 'wantUnreachable');
  assert.ok(warn.fix.includes('+' + w.insert.extra + '分'));
});

ok('避けたいエリアにある希望は「回れません」になる', () => {
  const t = wantTrip(['jp']);            // ジュラシック
  t.constraints.push({ type: 'avoid', areas: ['ジュラシック'], from: null, to: null, label: 'ゾンビ' });
  S.configure({ attractions, rules, layout, state: t });
  const c = S.course();
  assert.equal(c.wants[0].state, 'dropped');
  assert.equal(c.wants[0].why, 'ゾンビ');
  assert.ok(c.warns.find(x => x.kind === 'wantDropped').fix.includes('避ける時間帯'));
  S.configure({ attractions, rules, layout, state });
});

ok('屋内/水濡れの属性が候補に乗る（雨天の組み替え用）', () => {
  const t = S.emptyTrip();
  t.people = state.people;
  t.parkHours = { open: '09:00', close: '19:00', waitMin: null };
  t.tickets = [{ name: '1デイ', date: '2026-11-16', fixed: [], free: [] }];
  S.configure({ attractions, rules, layout, state: t });
  const items = S.plan().days[0].steps.filter(s => s.kind === 'move').flatMap(s => s.items);
  const kart = items.find(i => i.id === 'kart');
  assert.equal(kart.indoor, true, 'マリオカートは屋内');
  const jp = items.find(i => i.id === 'jp');
  assert.equal(jp.soaks, true, 'ジュラシックは水を浴びる');
  assert.equal(jp.indoor, false);
  // ★雨天は屋内が生命線。ワンダーランド追加で逃げ場が増えた（1歳の居場所ができた）
  const indoorAreas = [...new Set(attractions.filter(a => a.indoor).map(a => a.area))];
  assert.ok(indoorAreas.includes('ワンダーランド'), '1歳の逃げ場');
  assert.ok(indoorAreas.length >= 5, '屋内は5エリア以上: ' + indoorAreas.join('・'));
  // 78cm（1歳）が屋内で行けるところがゼロではないこと
  const tiny = { id: 'x', name: '1歳', h: 78, adult: false };
  const indoorOk = attractions.filter(a => a.indoor && S.judge(tiny, a).s === 'ok');
  assert.ok(indoorOk.length > 0, '雨でも行き先がある: ' + indoorOk.map(a => a.short).join('・'));
  S.configure({ attractions, rules, layout, state });
});

// ── 通りたくないエリア（ゾンビ等） ──
const avoidTrip = () => {
  const t = S.emptyTrip();
  t.people = state.people;
  t.parkHours = { open: '09:00', close: '21:00', waitMin: null };
  t.tickets = [{ name: '1デイ', date: '2026-10-10', fixed: [], free: [] }];
  return t;
};

ok('ハザードは期間内の日だけ候補に出す（避けるのは利用者が決める）', () => {
  assert.equal(S.hazards('2026-10-10').length, 1, 'ホラー・ナイト期間内');
  assert.equal(S.hazards('2026-08-11').length, 0, '期間外は出さない');
  const h = S.hazards('2026-10-10')[0];
  assert.equal(h.from, '18:00');
  // 2026-08-29 に公式（ストリート・ゾンビ）で検証済み。18:00〜パーククローズ・期間 9/11〜11/8
  assert.equal(h.verifiedAt, '2026-08-29');
  assert.ok(/5歳以下/.test(h.ageAdvisory || ''), '年齢の注意を持つ: ' + h.ageAdvisory);
  assert.deepEqual(h.safeAreas, ['ワンダーランド'], '公式マップのセーフティ・エリアは1か所');
  const t = avoidTrip();
  S.configure({ attractions, rules, layout, state: t });
  assert.equal(S.course().avoids.length, 0, '候補があっても勝手には避けない');
  assert.equal(S.course().warns.filter(w => w.kind === 'avoid').length, 0);
  S.configure({ attractions, rules, layout, state });
});

ok('避けたいエリアは候補から外れ、反対回りで迂回する', () => {
  const t = avoidTrip();
  // 17:30–18:00 にアミティの時間指定 → 以降は入口(ハリウッド)へ戻る。
  // 短いのは アミティ→ジュラシック→SF→NY→ハリウッド（15分）だが、18時以降は通れない
  t.tickets = [{ name: 'テスト券', date: '2026-10-10', free: [], fixed: [
    { at: '17:30', until: '18:00', name: 'ジョーズ' },
  ] }];
  t.constraints = [{ type: 'avoid', areas: ['ジュラシック'], from: '18:00', to: null, label: 'ゾンビ' }];
  S.configure({ attractions, rules, layout, state: t });
  const c = S.course();
  const moves = c.steps.filter(s => s.kind === 'move');
  assert.equal(moves[0].detour, 0, '18時より前の区間は迂回しない');
  const last = moves.pop();
  assert.ok(!last.path.includes('ジュラシック'), '18時以降はジュラシックを通らない');
  assert.ok(last.path.includes('ハリポタ') && last.path.includes('ミニオン'), '反対回りで入口へ戻る');
  assert.ok(last.path.includes('ワンダーランド'));
  assert.equal(last.detour, 10, '15分の道を25分で迂回する（ワンダーランド経由ぶん増）');
  const d = c.warns.find(w => w.kind === 'detour');
  assert.ok(d && d.ti.includes('遠回り'));
  assert.equal(c.warns.filter(w => w.kind === 'avoid').length, 0, '避けられたなら警告は出さない');
});

ok('避けた結果、回る先が無くなった区間を出す', () => {
  const t = avoidTrip();
  t.tickets = [{ name: 'テスト券', date: '2026-10-10', free: [], fixed: [
    { at: '17:30', until: '18:00', name: 'ジョーズ' },
  ] }];
  t.constraints = [{ type: 'avoid', areas: ['ジュラシック'], from: '18:00', to: null, label: 'ゾンビ' }];
  S.configure({ attractions, rules, layout, state: t });
  const e = S.course().warns.filter(w => w.kind === 'emptyWindow');
  assert.equal(e.length, 1, '夕方は迂回路の乗り物を午前に使い切っている');
  assert.ok(e[0].ti.includes('回る先がありません'));
  assert.ok(e[0].fix.includes('早めに切り上げる'), '撤退という判断を出す');
});

ok('避けられない場合は「避けられない」と出す（黙って通さない）', () => {
  const t = avoidTrip();
  t.constraints = [{ type: 'avoid', areas: ['ハリウッド'], from: '18:00', to: null, label: 'ゾンビ' }];
  S.configure({ attractions, rules, layout, state: t });
  const w = S.course().warns.filter(x => x.kind === 'avoid');
  assert.equal(w.length, 1);
  assert.ok(w[0].ti.includes('ハリウッド') && w[0].ti.includes('ゾンビ'));
  assert.ok(w[0].dt.includes('出口はハリウッド'), '出口が避けたいエリアにあることを言う');
  assert.ok(w[0].fix.includes('18:00より前に出る'), '行動を出す');
});

ok('時間指定が避けたいエリア・時間帯にあれば破綻として出す', () => {
  const t = avoidTrip();
  t.tickets = [{ name: 'テスト券', date: '2026-10-10', free: [], fixed: [
    { at: '19:00', until: '19:30', name: 'ジュラシック・パーク・ザ・ライド' },
  ] }];
  t.constraints = [{ type: 'avoid', areas: ['ジュラシック'], from: '18:00', to: null, label: 'ゾンビ' }];
  S.configure({ attractions, rules, layout, state: t });
  const w = S.course().warns.filter(x => x.kind === 'avoidFixed');
  assert.equal(w.length, 1);
  assert.ok(w[0].ti.includes('ジュラシック'));
  S.configure({ attractions, rules, layout, state });
});

ok('避ける時間帯の外なら普通に通れる（終日ではない）', () => {
  const t = avoidTrip();
  t.parkHours = { open: '09:00', close: '17:00', waitMin: null };   // 18時前に退園
  t.constraints = [{ type: 'avoid', areas: ['ジュラシック', 'ハリウッド'], from: '18:00', to: null, label: 'ゾンビ' }];
  S.configure({ attractions, rules, layout, state: t });
  const c = S.course();
  assert.equal(c.warns.filter(w => w.kind === 'avoid' || w.kind === 'detour').length, 0);
  assert.ok(c.steps.some(s => s.kind === 'move' && s.path.includes('ジュラシック')), '17時までなら通れる');
  assert.ok(c.steps.every(s => s.kind !== 'move' || !s.dropped.some(d => d.why === 'ゾンビ')));
  S.configure({ attractions, rules, layout, state });
});

ok('地理データが無ければ course は null（別パークでも壊れない）', () => {
  S.configure({ attractions, rules, layout: { ring: [] }, state });
  assert.equal(S.course(), null);
  S.configure({ attractions, rules, layout, state });
});

ok('開園・閉園の未入力は「これから決めること」へ流れる', () => {
  const u = S.undecided();
  assert.ok(u.some(x => x.what.includes('閉園時刻')), '11/16は帰りの日でないので逆算できない');
  assert.ok(u.some(x => x.what.includes('開園時刻')), '既定値は「入力済み」にしない');
  // 券に入場時間があればその日の開園は未定に出ない
  const withEntry = { ...state, tickets: [{ name: '1デイ', date: '2026-11-16', entryTime: '10:00', fixed: [], free: [] }] };
  S.configure({ attractions, rules, layout, state: withEntry });
  assert.ok(!S.undecided().some(x => x.what.includes('開園時刻')));
  assert.equal(S.course().open, '10:00');
  S.configure({ attractions, rules, layout, state });
});


// ── pro 専用: 雨の Finding（公開リポのエンジン取り込み時に移植） ──
ok('屋外率データを注入できる', () => {
  assert.equal(exposure._verified, false);
  Object.values(exposure.areas).forEach(v =>
    assert.ok(v === null || typeof v === 'number', '屋外率は数値か null のみ'));
  assert.equal(exposure.legModes.train, 0);
  S.configure({ attractions, rules, state, exposure });
  assert.ok(Array.isArray(S.solve()), 'exposure を渡しても solve が壊れない');
});

ok('パーク日があると雨の Finding が出る（数値なし）', () => {
  S.configure({ attractions, rules, state, exposure });
  const r = S.solve().filter(x => x.kind === 'rain');
  assert.ok(r.length >= 1, 'rain Finding が出ていない');
  const warn = r.find(x => x.lv === 'warn');
  assert.ok(warn, 'warn が1件も無い');
  assert.match(warn.ti, /11\/1[567]/, '日付が入っていない: ' + warn.ti);
  assert.doesNotMatch(warn.dt, /\d+\s*時間|\d+\s*分/,
    '屋外率が未設定なのに時間を出している: ' + warn.dt);
  assert.match(warn.fix, /レインコート/);
});

ok('入場日が無ければ雨の Finding を出さない', () => {
  const s2 = JSON.parse(JSON.stringify(state));
  s2.tickets.forEach(t => { t.date = null; });
  S.configure({ attractions, rules, state: s2, exposure });
  assert.equal(S.solve().filter(x => x.kind === 'rain').length, 0);
  S.configure({ attractions, rules, state, exposure });
});

ok('滞在時間と屋外率が揃うと推定時間を出す', () => {
  const s3 = JSON.parse(JSON.stringify(state));
  // fixture の tickets[0]（11-15・1.5デイ券）は対象アトラクションを持たない（fixed=0 free=0）。
  // 全券に付けないと、アトラクションを持つ 11-16 の券に滞在時間が乗らず推定が出ない。
  s3.tickets.forEach(t => { t.stayHours = 8; });
  const ex3 = JSON.parse(JSON.stringify(exposure));
  Object.keys(ex3.areas).forEach(k => { ex3.areas[k] = 0.8; });
  S.configure({ attractions, rules, state: s3, exposure: ex3 });
  const warn = S.solve().find(x => x.kind === 'rain' && x.lv === 'warn');
  assert.match(warn.dt, /およそ/, '推定時間が出ていない: ' + warn.dt);
  assert.match(warn.dt, /未検証/, '未検証の断り書きが無い: ' + warn.dt);
  S.configure({ attractions, rules, state, exposure });
});

ok('_verified:true になると「未検証」の断り書きが消える（false 側は出続ける）', () => {
  const s3v = JSON.parse(JSON.stringify(state));
  s3v.tickets.forEach(t => { t.stayHours = 8; });
  const exVerified = JSON.parse(JSON.stringify(exposure));
  Object.keys(exVerified.areas).forEach(k => { exVerified.areas[k] = 0.8; });
  exVerified._verified = true;
  S.configure({ attractions, rules, state: s3v, exposure: exVerified });
  const warnVerified = S.solve().find(x => x.kind === 'rain' && x.lv === 'warn');
  assert.match(warnVerified.dt, /およそ/, '検証済みでも推定時間自体は出るはず: ' + warnVerified.dt);
  assert.doesNotMatch(warnVerified.dt, /未検証/,
    '検証済みなのに「未検証」が残っている: ' + warnVerified.dt);

  const exUnverified = JSON.parse(JSON.stringify(exposure));
  Object.keys(exUnverified.areas).forEach(k => { exUnverified.areas[k] = 0.8; });
  S.configure({ attractions, rules, state: s3v, exposure: exUnverified });
  const warnUnverified = S.solve().find(x => x.kind === 'rain' && x.lv === 'warn');
  assert.match(warnUnverified.dt, /未検証/,
    '未検証のはずが断り書きが消えている: ' + warnUnverified.dt);

  S.configure({ attractions, rules, state, exposure });
});

ok('屋外率が一部 null なら一部不明と書く', () => {
  const s4 = JSON.parse(JSON.stringify(state));
  s4.tickets.forEach(t => { t.stayHours = 8; });
  const ex4 = JSON.parse(JSON.stringify(exposure));
  ex4.areas['マリオ'] = 0.8;   // 他は null のまま
  S.configure({ attractions, rules, state: s4, exposure: ex4 });
  const r = S.solve().filter(x => x.kind === 'rain');
  assert.ok(r.some(x => /未設定/.test(x.dt)), '一部不明の断りが無い');
  S.configure({ attractions, rules, state, exposure });
});

ok('帰りの日は mode があるときだけ屋外を出す', () => {
  const s5 = JSON.parse(JSON.stringify(state));
  const dep = s5.constraints.find(c => c.type === 'departure');
  dep.legs[0].mode = 'indoor';      // 保安検査 60分
  dep.legs[1].mode = 'train';       // リムジンバス 40分
  dep.legs[2].mode = 'wait_open';   // 乗り場で待つ 30分
  S.configure({ attractions, rules, state: s5, exposure });
  const ret = S.solve().find(x => x.kind === 'rain' && /帰りの日/.test(x.ti));
  assert.ok(ret, '帰りの日の Finding が無い');
  assert.match(ret.ti, /30分/, '屋外30分になっていない: ' + ret.ti);
  assert.equal(ret.lv, 'note');
  S.configure({ attractions, rules, state, exposure });
});

ok('mode が無い脚は推測せず帰りの Finding を出さない', () => {
  S.configure({ attractions, rules, state, exposure });
  assert.equal(S.solve().filter(x => x.kind === 'rain' && /帰りの日/.test(x.ti)).length, 0);
});

ok('一部の脚だけ mode があるとき、未設定の区間は合計から除外し、その旨を書く', () => {
  const s6 = JSON.parse(JSON.stringify(state));
  const dep = s6.constraints.find(c => c.type === 'departure');
  dep.legs[0].mode = 'indoor';      // 保安検査 60分（屋外0分）
  // legs[1] リムジンバス 40分は mode 未設定のまま
  dep.legs[2].mode = 'wait_open';   // 乗り場で待つ 30分（屋外30分）
  S.configure({ attractions, rules, state: s6, exposure });
  const ret = S.solve().find(x => x.kind === 'rain' && /帰りの日/.test(x.ti));
  assert.ok(ret, '帰りの日の Finding が無い');
  assert.match(ret.ti, /30分/, '既知の脚だけの合計になっていない: ' + ret.ti);
  assert.match(ret.dt, /種別が未設定の区間は含めていません。/,
    '未設定区間を除外したことが書かれていない: ' + ret.dt);
  S.configure({ attractions, rules, state, exposure });
});

ok('帰りの日 note は partial:false のときだけ完全性を断言する（C2）', () => {
  const sFull = JSON.parse(JSON.stringify(state));
  const depFull = sFull.constraints.find(c => c.type === 'departure');
  depFull.legs[0].mode = 'indoor';
  depFull.legs[1].mode = 'train';
  depFull.legs[2].mode = 'wait_open';
  S.configure({ attractions, rules, state: sFull, exposure });
  const retFull = S.solve().find(x => x.kind === 'rain' && /帰りの日/.test(x.ti));
  assert.ok(retFull, '帰りの日の Finding が無い（全脚 mode あり）');
  assert.equal(retFull.dt, '移動の大半は屋内か車内で、濡れるのはこの分だけです。',
    'partial:false の文言が変わっている: ' + retFull.dt);
  S.configure({ attractions, rules, state, exposure });
});

ok('帰りの日 note は partial:true のとき完全性を断言しない（C2・新幹線既定 TRAIN_LEGS の再現）', () => {
  const sPartial = JSON.parse(JSON.stringify(state));
  const depPartial = sPartial.constraints.find(c => c.type === 'departure');
  // 新幹線既定 TRAIN_LEGS の「駅への移動」相当：mode を持たせない
  depPartial.legs[0].mode = 'wait_covered';
  // legs[1] は mode 未設定のまま（駅への移動＝手段不明で安全側に倒す設計）
  depPartial.legs[2].mode = 'wait_open';
  S.configure({ attractions, rules, state: sPartial, exposure });
  const retPartial = S.solve().find(x => x.kind === 'rain' && /帰りの日/.test(x.ti));
  assert.ok(retPartial, '帰りの日の Finding が無い（一部 mode 無し）');
  assert.equal(retPartial.dt, '種別が分かっている区間だけの集計です。種別が未設定の区間は含めていません。',
    'partial:true の文言が変わっている: ' + retPartial.dt);
  assert.ok(!/濡れるのはこの分だけです/.test(retPartial.dt),
    'partial:true なのに完全性を断言する文言が残っている: ' + retPartial.dt);
  S.configure({ attractions, rules, state, exposure });
});

ok('滞在時間と区間の種別を問診に積む', () => {
  S.configure({ attractions, rules, state, exposure });
  const u = S.undecided().map(x => x.what);
  assert.ok(u.some(w => /滞在時間/.test(w)), '滞在時間が問診に無い: ' + JSON.stringify(u));
  assert.ok(u.some(w => /区間の種別/.test(w)), '区間の種別が問診に無い');
});

ok('既存 Finding の kind 集合が変わらない', () => {
  S.configure({ attractions, rules, state });
  const EXPECTED = ['adjacent', 'cancelTrap', 'deadSlot', 'edge', 'edge', 'singlePoint', 'usable'];
  const got = S.solve().filter(x => x.kind !== 'rain').map(x => x.kind).sort();
  assert.deepEqual(got, EXPECTED.slice().sort(),
    '既存 Finding が変わった。実際: ' + JSON.stringify(got));
});

ok('web/index.html の S.configure() 呼び出しに exposure が渡っている', () => {
  const html = readFileSync(join(root, 'web/index.html'), 'utf8');
  const m = html.match(/S\.configure\(\{([^}]*)\}\);/);
  assert.ok(m, 'web/index.html に S.configure({...}); が見つからない');
  assert.match(m[1], /exposure:\s*DATA\.exposure/,
    'web/index.html の S.configure() に exposure（DATA.exposure）が渡っていない（UI 配線の欠落）: ' + m[0]);
});

console.log(`\n${pass} 件すべて成功`);
