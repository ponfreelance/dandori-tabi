/* 段取りたび — 貼り付けパーサー（tests/fixtures/parse_test.py と同一挙動を保つこと）
   ブラウザ・Node 両対応。globalThis.DandoriParser に公開する。 */
(function (g) {
  'use strict';

  /* ★順序厳守：™®はNFKC「前」に除去（後だと"TM"化して名前突合が全滅する） */
  function norm(s) {
    s = s.replace(/™/g, '').replace(/®/g, '');
    s = s.normalize('NFKC');
    s = s.replace(/～/g, '~').replace(/〜/g, '~');
    return s.replace(/　/g, ' ');
  }

  const DATE_PATTERNS = [
    [/(\d{4})年(\d{1,2})月(\d{1,2})日/g, '和式'],
    [/(\d{4})\/(\d{2})\/(\d{2})/g, 'スラッシュ'],
  ];

  function dates(t) {
    const out = [];
    for (const [pat, label] of DATE_PATTERNS) {
      pat.lastIndex = 0;
      let m;
      while ((m = pat.exec(t)) !== null) {
        const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
        out.push([
          `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
          label, m[0],
        ]);
      }
    }
    return out;
  }

  function times(t) {
    return (t.match(/\d{1,2}:\d{2}/g) || []);
  }

  /* 金額。書き出し時は既定で非表示にするが、抽出はしておく */
  function price(t) {
    const m = t.match(/[¥￥]\s*([\d,]+)|([\d,]+)\s*円/);
    if (!m) return null;
    return Number((m[1] || m[2]).replace(/,/g, ''));
  }

  function parseFlight(raw) {
    const t = norm(raw);
    const dd = dates(t);
    const legs = t.match(/(\S+?)(\d{1,2}:\d{2})発\s*(\S+?)(\d{1,2}:\d{2})着/);
    const seats = t.match(/座席番号[:：]\s*([\w.]+)/);
    const cabin = t.match(/クラス\s*([A-Z])/);
    const flight = t.match(/([A-Z]{2,3}\d{1,4})便/);   // ★3文字コード対応（2文字マッチだとJALxxxがALxxxに化けた実バグ）
    return {
      type: 'flight',
      date: dd.length ? dd[0][0] : null,
      flightNo: flight ? flight[1] : null,
      from: legs ? legs[1] : null, depart: legs ? legs[2] : null,
      to: legs ? legs[3] : null, arrive: legs ? legs[4] : null,
      cabin: cabin ? 'クラス' + cabin[1] : null,
      seats: seats ? seats[1].split('.') : [],
      price: price(t),
    };
  }

  function parseUsj(raw) {
    const t = norm(raw);
    const tickets = [];
    let cur = null, mode = null;
    for (let line of t.split('\n')) {
      line = line.trim();
      if (!line) continue;
      if (line.includes('パス') && !line.includes('入場日') && !line.includes('対象')) {
        cur = { name: line, date: null, entryTime: null, no: null, fixed: [], free: [], price: price(line) };
        tickets.push(cur); mode = null; continue;
      }
      if (cur === null) continue;
      if (line.startsWith('入場日')) {
        const dd = dates(line);
        cur.date = dd.length ? dd[0][0] : null; continue;
      }
      if (line.startsWith('入場時間')) {
        const tt = times(line);
        cur.entryTime = tt.length ? tt[0] : null; continue;
      }
      if (line.startsWith('チケット番号')) {
        const m = line.match(/(P:[\d.]+)/);
        cur.no = m ? m[1] : null; continue;
      }
      if (line.includes('時間指定あり')) { mode = 'fixed'; continue; }
      if (line.includes('時間指定なし')) { mode = 'free'; continue; }
      if (mode === 'fixed') {
        const m = line.match(/^(\d{1,2}:\d{2})~\s*(\d{1,2}:\d{2})?\s*(.+)/);
        if (m) {
          let nm = m[3].trim();
          let reentry = null;
          if (nm.includes('再入場不可')) {   // ★括弧内に埋もれる。見落とすと衝突検出が動かない
            reentry = false;
            nm = nm.replace(/\s*\(再入場不可\)/, '').trim();
          }
          cur.fixed.push({ at: m[1], until: m[2] || null, name: nm, reentry });
        }
      } else if (mode === 'free') {
        cur.free.push(line);
      }
    }
    return { type: 'parkTickets', tickets };
  }

  function parseHotel(raw) {
    const t = norm(raw);
    const L = t.split('\n').map(l => l.trim()).filter(Boolean);
    const dd = dates(t);
    const pax = t.match(/大人(\d+)名[,、]\s*子供(\d+)名[,、]\s*(\d+)室/);
    const plan = L.find(l => l.includes('プラン')) || null;
    const meals = {};
    if (plan) {
      meals.breakfast = plan.includes('朝食') || plan.includes('朝夕') || plan.includes('2食');
      meals.dinner = plan.includes('夕食') || plan.includes('朝夕') || plan.includes('2食');
    }
    return {
      type: 'hotel',
      name: L.length ? L[0] : null,
      room: L.length > 1 ? L[1] : null,
      plan,
      checkIn: dd.length ? dd[0][0] : null,
      checkOut: dd.length > 1 ? dd[1][0] : null,
      adults: pax ? Number(pax[1]) : null,
      children: pax ? Number(pax[2]) : null,
      rooms: pax ? Number(pax[3]) : null,
      meals,
      price: price(t),
    };
  }

  /* 新幹線・在来線特急の控え。
     TODO(fixture): 実物の控えでの検証待ち（現状はSmartEX/EX予約の一般的な書式に合わせた合成データのみ） */
  const TRAIN_NAMES = 'のぞみ|ひかり|こだま|みずほ|さくら|つばめ|はやぶさ|はやて|やまびこ|なすの|とき|たにがわ|かがやき|はくたか|あさま|つるぎ|こまち|つばさ';

  function parseTrain(raw) {
    const t = norm(raw);
    const dd = dates(t);
    const train = t.match(new RegExp(`((?:${TRAIN_NAMES})\\s*\\d{1,4}号)`));
    /* 「東京（06:00発）」「東京 06:00発」の両形式を受ける */
    const dep = t.match(/([^\s（(→]+)\s*[（(]?(\d{1,2}:\d{2})[）)]?\s*発/);
    const arr = t.match(/([^\s（(→]+)\s*[（(]?(\d{1,2}:\d{2})[）)]?\s*着/);
    const seats = t.match(/(\d{1,2})号車\s*([\dA-E,、.番席\s]+)/);
    return {
      type: 'train',
      date: dd.length ? dd[0][0] : null,
      trainName: train ? train[1].replace(/\s+/g, '') : null,
      from: dep ? dep[1] : null, depart: dep ? dep[2] : null,
      to: arr ? arr[1] : null, arrive: arr ? arr[2] : null,
      car: seats ? Number(seats[1]) : null,
      seats: seats ? seats[2].replace(/[番席\s]/g, '').split(/[,、.]/).filter(Boolean) : [],
      price: price(t),
    };
  }

  /* 種別を自動判別して部分パースする。判別できなくても落とさない（部分入力で動く） */
  function detect(raw) {
    const t = norm(raw);
    if (/便|搭乗/.test(t) && /[A-Z]{2,3}\d{1,4}/.test(t)) return 'flight';
    if (new RegExp(`(?:${TRAIN_NAMES})\\s*\\d{1,4}号`).test(t) ||
        (/新幹線|スマートEX|EX予約/.test(t) && /発|着|指定席/.test(t))) return 'train';
    if (t.includes('パス') || t.includes('アトラクション') || /チケット番号/.test(t)) return 'parkTickets';
    if (t.includes('ホテル') || t.includes('宿') || /泊|チェックイン|室/.test(t)) return 'hotel';
    return null;
  }

  function parseAny(raw) {
    const kind = detect(raw);
    const parsed =
      kind === 'flight' ? parseFlight(raw) :
      kind === 'train' ? parseTrain(raw) :
      kind === 'parkTickets' ? parseUsj(raw) :
      kind === 'hotel' ? parseHotel(raw) : null;
    if (!parsed) return { type: null, error: '種別を判別できませんでした', raw };
    parsed.source = 'paste';
    parsed.status = '仮';   // 貼り付け由来は「仮」。ユーザーが確認して「確定」に上げる
    return parsed;
  }

  g.DandoriParser = { norm, dates, times, price, parseFlight, parseTrain, parseUsj, parseHotel, detect, parseAny };
})(typeof window !== 'undefined' ? window : globalThis);
