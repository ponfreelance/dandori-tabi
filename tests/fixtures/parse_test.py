# -*- coding: utf-8 -*-
"""貼り付け入力のスキーマ適合検証。
素材は実際に貼られた控えの構造・表記ゆれ（™/全角チルダ/タブ/和式・スラッシュ日付/3文字便名コード）を
そのまま保った加工値。日付・便名・座席・チケット番号・施設名は架空。"""
import re, json, unicodedata

SAMPLES = {
"A_flight": """旅程1

2026年11月17日（火）　JAL876便

大阪(伊丹)15:35発\t\t東京(羽田)17:00着

座席：クラス J 座席番号：21A.21C.21D.21H""",

"B_usj": """1.5デイ・スタジオ・パス　大人
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
ザ・フライング・ダイナソー""",

"C_hotel": """ホテル ポートサイド ガーデン
ファミリー ワンダールーム
シェフこだわりの朝食ビュッフェ付プラン
日程・人数
2026/11/15(日)〜2026/11/17(火)
大人2名, 子供3名, 1室""",
}

def norm(s):
    s = s.replace('™','').replace('®','')      # NFKC前に除去（™→"TM"化を防ぐ）
    s = unicodedata.normalize('NFKC', s)
    s = s.replace('～','~').replace('〜','~')
    return s.replace('\u3000',' ')

DATE_PATTERNS = [
    (r'(\d{4})年(\d{1,2})月(\d{1,2})日', '和式'),
    (r'(\d{4})/(\d{1,2})/(\d{1,2})',    'スラッシュ'),
]
def dates(t):
    out=[]
    for pat,label in DATE_PATTERNS:
        for m in re.finditer(pat, t):
            y,mo,d = map(int, m.groups())
            out.append((f"{y:04d}-{mo:02d}-{d:02d}", label, m.group(0)))
    return out

def times(t):
    return re.findall(r'(\d{1,2}:\d{2})', t)

# ── 各サンプルのパース ──
def parse_flight(raw):
    t = norm(raw)
    d = dates(t)[0][0]
    legs = re.search(r'(\S+?)(\d{1,2}:\d{2})発\s*(\S+?)(\d{1,2}:\d{2})着', t)
    seats = re.search(r'座席番号[:：]\s*([\w.]+)', t)
    cabin = re.search(r'クラス\s*([A-Z])', t)
    flight= re.search(r'([A-Z]{2,3}\d{1,4})便', t)
    return {
      'type':'flight', 'date':d,
      'flightNo': flight.group(1) if flight else None,
      'from': legs.group(1) if legs else None, 'depart': legs.group(2) if legs else None,
      'to':   legs.group(3) if legs else None, 'arrive': legs.group(4) if legs else None,
      'cabin': ('クラス'+cabin.group(1)) if cabin else None,
      'seats': seats.group(1).split('.') if seats else [],
    }

def parse_usj(raw):
    t = norm(raw)
    tickets=[]; cur=None; mode=None
    for line in t.split('\n'):
        line=line.strip()
        if not line: continue
        if 'パス' in line and '入場日' not in line and '対象' not in line:
            cur={'name':line,'date':None,'entryTime':None,'no':None,'fixed':[],'free':[]}
            tickets.append(cur); mode=None; continue
        if cur is None: continue
        if line.startswith('入場日'):
            dd=dates(line)
            cur['date']=dd[0][0] if dd else None; continue
        if line.startswith('入場時間'):
            tt=times(line); cur['entryTime']=tt[0] if tt else None; continue
        if line.startswith('チケット番号'):
            m=re.search(r'(P:[\d.]+)',line); cur['no']=m.group(1) if m else None; continue
        if '時間指定あり' in line: mode='fixed'; continue
        if '時間指定なし' in line: mode='free'; continue
        if mode=='fixed':
            m=re.match(r'(\d{1,2}:\d{2})~\s*(\d{1,2}:\d{2})?\s*(.+)', line)
            if m:
                nm=m.group(3).strip()
                reentry = None
                if '再入場不可' in nm:
                    reentry=False; nm=re.sub(r'\s*\(再入場不可\)','',nm).strip()
                cur['fixed'].append({'at':m.group(1),'until':m.group(2),
                                     'name':nm,'reentry':reentry})
        elif mode=='free':
            cur['free'].append(line)
    return {'type':'parkTickets','tickets':tickets}

def parse_hotel(raw):
    t = norm(raw)
    L=[l.strip() for l in t.split('\n') if l.strip()]
    dd=dates(t)
    pax=re.search(r'大人(\d+)名[,、]\s*子供(\d+)名[,、]\s*(\d+)室', t)
    plan=next((l for l in L if 'プラン' in l), None)
    meals={}
    if plan:
        meals['breakfast'] = ('朝食' in plan) or ('朝夕' in plan) or ('2食' in plan)
        meals['dinner']    = ('夕食' in plan) or ('朝夕' in plan) or ('2食' in plan)
    return {
      'type':'hotel','name':L[0] if L else None,
      'room': L[1] if len(L)>1 else None, 'plan':plan,
      'checkIn': dd[0][0] if dd else None, 'checkOut': dd[1][0] if len(dd)>1 else None,
      'adults': int(pax.group(1)) if pax else None,
      'children': int(pax.group(2)) if pax else None,
      'rooms': int(pax.group(3)) if pax else None,
      'meals': meals,
    }

res = {'A_flight':parse_flight(SAMPLES['A_flight']),
       'B_usj':   parse_usj(SAMPLES['B_usj']),
       'C_hotel': parse_hotel(SAMPLES['C_hotel'])}
print(json.dumps(res, ensure_ascii=False, indent=1))

print("\n=== 日付フォーマットの揺れ ===")
for k,v in SAMPLES.items():
    print(k, [ (raw,label) for _,label,raw in dates(norm(v)) ][:2])

print("\n=== アトラクション名の突合 ===")
MASTER = [norm(x) for x in ['マリオカート ～クッパの挑戦状～','ヨッシー・アドベンチャー',
          'ハリウッド・ドリーム・ザ・ライド','ミニオン・ハチャメチャ・ライド',
          'ザ・フライング・ダイナソー','スーパー・ニンテンドー・ワールド']]
got=[]
for t in res['B_usj']['tickets']:
    got += [f['name'] for f in t['fixed']] + t['free']
for g in got:
    print(('  OK  ' if g in MASTER else '  MISS'), repr(g))
