#!/usr/bin/env python3
"""Builds the single-page game: src/game.template.html with the sources inlined -> dist/index.html.
Usage: python3 build.py   (needs Node.js on the path to read the board data)"""
import os, subprocess
ROOT = os.path.dirname(os.path.abspath(__file__))
SRC, DIST = os.path.join(ROOT, 'src'), os.path.join(ROOT, 'dist')
read = lambda f: open(os.path.join(SRC, f), encoding='utf-8').read()
data = lambda f: subprocess.check_output(['node', '-e', f"process.stdout.write(JSON.stringify(require({os.path.join(SRC, f)!r})))"]).decode()
board3d = read('board3d.js').replace("if (typeof module !== 'undefined') module.exports = createBoard3D;", "")
page = (read('game.template.html')
        .replace('%%BOARD%%', data('board-1986.js'))
        .replace('%%SCENERY%%', data('scenery-1986.js'))
        .replace('%%BOARD3D%%', board3d)
        .replace('%%ENGINE%%', read('engine.js'))
        .replace('%%BOTS%%', read('bots.js'))
        .replace('%%SOUND%%', read('sound-assets.js') + '\n' + read('sound.js')))
# a proper document head: standards mode, and the viewport tag that makes phones lay the page out at their own width
# (without it mobile browsers render a 980px desktop page and shrink it). viewport-fit=cover lets the safe-area insets work.
page = ('<!doctype html>\n<html lang="en">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        '<meta name="theme-color" content="#2b2724">\n' + page)
os.makedirs(DIST, exist_ok=True)
open(os.path.join(DIST, 'index.html'), 'w', encoding='utf-8').write(page)
print(f'dist/index.html written ({len(page) / 1e6:.2f} MB)')
