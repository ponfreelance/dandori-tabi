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

// 5. 身長判定（公式2026-07-23検証値・2値モデル）
//    大人同伴が前提の家族では minHeightWithAdult で判定する。
//    トロッコは同伴107cm（旧データの122は単独値）→ 7歳120cmは ○7/△1/×2 になる
ok('7歳120cm（大人同伴）→ ○7/△1/×2', () => {
  const c = S.verdictCounts(state.people[2]);
  assert.deepEqual([c.ok, c.edge, c.ng], [7, 1, 2]);
});
ok('7歳122cm（大人同伴）→ ○8/△0/×2', () => {
  const c = S.verdictCounts({ ...state.people[2], h: 122 });
  assert.deepEqual([c.ok, c.edge, c.ng], [8, 0, 2]);
});
ok('7歳100cm（大人同伴）→ ○3/△1/×6（従来と同じ）', () => {
  const c = S.verdictCounts({ ...state.people[2], h: 100 });
  assert.deepEqual([c.ok, c.edge, c.ng], [3, 1, 6]);
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

// 追加検証: 新幹線控えのパース
// TODO(fixture): 合成データ（SmartEX/EX予約の一般的な書式）。実物の控えでの検証待ち
ok('新幹線控えのパース（合成・要実物検証）', () => {
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
  assert.equal(w.min, 9);                       // ハリウッド→ミニオン4→マリオ5
  assert.deepEqual(w.path, ['ハリウッド', 'ミニオン', 'マリオ']);
  const back = S.walk('マリオ', 'ハリウッド');
  assert.equal(back.min, 9, '逆向きも同じ');
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
  assert.deepEqual(first.path, ['ハリウッド', 'ミニオン', 'マリオ']);
  assert.equal(first.walkMin, 9);
  assert.equal(first.spanMin, 150);             // 09:00→11:30
  assert.equal(first.restMin, 141);
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
  assert.equal(first.walkMin, 39);
  assert.equal(first.capacity, 12);              // (600−39)/45
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
  assert.ok(w[0].dt.includes('徒歩11分'), 'ミニオン→マリオ5→ハリポタ6');
  assert.ok(w[0].dt.includes('6分たりません'));  // 5分の窓に11分
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
  assert.equal(c.walkMin, 39, '実際は一周する（午後の空き時間で反対側を回る）');
  assert.equal(c.forcedWalkMin, 18, '固定点が強いるのは入口↔マリオの往復ぶんだけ');
  assert.equal(c.warns.filter(w => w.kind === 'backtrack').length, 0);
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
  assert.equal(h.verifiedAt, null, '未検証であることを持つ');
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
  assert.equal(last.detour, 9, '15分の道を24分で迂回する');
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

console.log(`\n${pass} 件すべて成功`);
