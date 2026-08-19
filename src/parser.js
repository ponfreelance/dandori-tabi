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
    [/(\d{4})\/(\d{1,2})\/(\d{1,2})/g, 'スラッシュ'],
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

  /* スマートEX／EX予約アプリの「詳細」画面をそのまま貼れること。
     実物は控えのテキストと書式が違う（2026-08-15 実機の控えで確認）:
       乗車日時  2026/7/4（土） 9:03 → 11:28      ← 1桁月日・矢印・発着の文字なし
       区間      新横浜 → 京都
       人数      おとな 2　こども 2
       のぞみ 271                                  ← 「号」がない
       座席      9号車 7番 D/E席, 8番 D/E席        ← 4席ぶんを畳んだ表記
     旧来の「のぞみ42号 / 新大阪 16:30発 / 7号車 11A,11B,11C」も引き続き受ける。 */
  function parseTrain(raw) {
    const t = norm(raw);
    const dd = dates(t);
    const train = t.match(new RegExp(`((?:${TRAIN_NAMES})\\s*\\d{1,4}\\s*号?)`));

    /* 発着：「東京（06:00発）」「東京 06:00発」 */
    const dep = t.match(/([^\s（(→]+)\s*[（(]?(\d{1,2}:\d{2})[）)]?\s*発/);
    const arr = t.match(/([^\s（(→]+)\s*[（(]?(\d{1,2}:\d{2})[）)]?\s*着/);
    /* 矢印形式：「9:03 → 11:28」と「新横浜 → 京都」。
       駅名側は先頭が数字・コロンでないことで時刻行と切り分ける */
    const span = t.match(/(\d{1,2}:\d{2})\s*[→~]\s*(\d{1,2}:\d{2})/);
    const sec = t.match(/([^\s→~\d:][^\s→~]*)\s*[→~]\s*([^\s→~\n]+)/);

    /* 座席：「7番 D/E席」は 7D と 7E の2席。畳まれた表記を展開しないと席数を取り違える */
    let car = null, seats = [];
    const carM = t.match(/(\d{1,2})\s*号車/);
    if (carM) car = Number(carM[1]);
    const folded = [...t.matchAll(/(\d{1,3})\s*番\s*([A-E](?:\s*[\/・,、]\s*[A-E])*)\s*席/g)];
    if (folded.length) {
      folded.forEach(g => g[2].split(/[\/・,、\s]+/).filter(Boolean)
        .forEach(L => seats.push(g[1] + L)));
    } else {
      const flat = t.match(/(\d{1,2})号車\s*([\dA-E,、.番席\s]+)/);
      if (flat) {
        if (car === null) car = Number(flat[1]);
        seats = flat[2].replace(/[番席\s]/g, '').split(/[,、.]/).filter(Boolean);
      }
    }

    /* 人数。席数との突合に使う（幼児は席なしのことがあるので、突合は使う側の判断） */
    /* 「8:59」を「08:59」へ。時刻は桁を揃えて持つ（表示と比較のため） */
    const hhmm = x => x ? x.replace(/^(\d):/, '0$1:') : x;
    const ad = t.match(/(?:おとな|大人)\s*(\d{1,2})/);
    const ch = t.match(/(?:こども|子供|小児)\s*(\d{1,2})/);
    const prod = t.match(/(スマート\s*EX|EX\s*予約|エクスプレス\s*予約)/);

    return {
      type: 'train',
      date: dd.length ? dd[0][0] : null,
      trainName: train ? train[1].replace(/\s+/g, '') : null,
      from: dep ? dep[1] : (sec ? sec[1] : null),
      depart: hhmm(dep ? dep[2] : (span ? span[1] : null)),
      to: arr ? arr[1] : (sec ? sec[2] : null),
      arrive: hhmm(arr ? arr[2] : (span ? span[2] : null)),
      car, seats,
      adults: ad ? Number(ad[1]) : null,
      children: ch ? Number(ch[1]) : null,
      product: prod ? prod[1].replace(/\s+/g, '') : null,
      price: price(t),
    };
  }

  function detect(raw) {
    const t = norm(raw);
    if (/便|搭乗/.test(t) && /[A-Z]{2,3}\d{1,4}/.test(t)) return 'flight';
    /* 「のぞみ42号」だけでなく、スマートEXアプリの「のぞみ 339」（号なし）も拾う */
    if (new RegExp(`(?:${TRAIN_NAMES})\\s*\\d{1,4}`).test(t) ||
        (/新幹線|スマート\s*EX|EX\s*予約|号車/.test(t) && /発|着|指定席|→/.test(t))) return 'train';
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
