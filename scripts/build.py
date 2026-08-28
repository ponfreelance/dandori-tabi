# -*- coding: utf-8 -*-
"""data/*.json と src/*.js を web/index.html のマーカー区間へ埋め込む。
①はオフライン単一HTMLで配布する要件のため、外部fetchではなく埋め込み方式を取る。
正はあくまで data/*.json と src/*.js。HTML側を直接編集しないこと。
実行: python -X utf8 scripts/build.py
"""
import json
import re
import pathlib

root = pathlib.Path(__file__).resolve().parents[1]
html_path = root / 'web' / 'index.html'
html = html_path.read_text(encoding='utf-8')

attractions = json.loads((root / 'data' / 'attractions.usj.json').read_text(encoding='utf-8'))
rules = json.loads((root / 'data' / 'booking-rules.json').read_text(encoding='utf-8'))
exposure = json.loads((root / 'data' / 'exposure.usj.json').read_text(encoding='utf-8'))
layout = json.loads((root / 'data' / 'park-layout.usj.json').read_text(encoding='utf-8'))
# 実監視の宿・日付が公開物へ混入しないよう、埋め込みでは
# (a) watchOnly ルールを丸ごと除外（label/note に実宿名・実日付を持つ）
# (b) 残りのルールから watch キーを落とす（①は watch を読まない）
rules['rules'] = [r for r in rules['rules'] if not r.get('watchOnly')]
for r in rules['rules']:
    r.pop('watch', None)
data_js = 'window.DANDORI_DATA = ' + json.dumps(
    {'attractions': attractions, 'bookingRules': rules, 'exposure': exposure, 'layout': layout}, ensure_ascii=False, indent=1) + ';'

lib_js = '\n'.join(
    (root / 'src' / f).read_text(encoding='utf-8') for f in ['parser.js', 'solver.js'])


def inject(text, tag, payload):
    begin, end = f'/* =={tag}:BEGIN== */', f'/* =={tag}:END== */'
    pat = re.compile(re.escape(begin) + '.*?' + re.escape(end), re.S)
    if not pat.search(text):
        raise SystemExit(f'marker not found: {tag}')
    return pat.sub(lambda m: begin + '\n' + payload + '\n' + end, text)


html = inject(html, 'DATA', data_js)
html = inject(html, 'LIB', lib_js)
html_path.write_text(html, encoding='utf-8', newline='\n')
print('embedded: data/*.json + src/*.js -> web/index.html')
