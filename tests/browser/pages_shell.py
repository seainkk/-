"""Cold start of the assembled Pages artifact. Every origin is fulfilled locally."""
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
HOST = 'https://seainkk.github.io'


def main():
    tests_dir = ROOT / 'test-results'
    tests_dir.mkdir(exist_ok=True)
    with TemporaryDirectory(dir=tests_dir) as output, sync_playwright() as pw:
        subprocess.run(['node', 'scripts/build-pages.mjs', output], cwd=ROOT, check=True,
                       env={**os.environ, 'FIREBASE_DIRECTORY_PROJECT':'directory-test'})
        build = Path(output)
        asset = (build / 'registry.js').read_bytes()
        version = hashlib.sha256(asset).hexdigest()[:16]
        fixture = Path(__file__).with_name('performance-fixture.js').read_text(encoding='utf-8')
        bridge = (ROOT / 'src/PagesBridge.html').read_text(encoding='utf-8')
        bridge = bridge.replace('<script>', '<script>'+fixture+"\nbackend.holdMethods=['getAppBootstrap'];</script><script>", 1)
        chrome = {'channel':'chrome'} if sys.platform == 'win32' else {'executable_path':'/usr/bin/chromium'}
        browser = pw.chromium.launch(**chrome)
        context = browser.new_context()
        page = context.new_page()
        errors, bundles, directories = [], [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        release_scripts = False

        def route_request(route):
            url = urlsplit(route.request.url)
            if url.hostname == 'seainkk.github.io' and url.path in ['/-/','/-/app.html','/-/favicon.png']:
                route.fulfill(path=build / (url.path[3:] or 'index.html'))
            elif url.hostname == 'seainkk.github.io' and url.path == '/-/registry.js':
                assert parse_qs(url.query) == {'v':[version]}
                if release_scripts:
                    route.fulfill(content_type='text/javascript; charset=utf-8', body=asset)
                else:
                    bundles.append(route)
            elif url.hostname == 'firestore.googleapis.com' and url.path.endswith(':batchGet'):
                directories.append(route)
            elif url.hostname == 'script.google.com' and parse_qs(url.query).get('bridge') == ['1']:
                channel = parse_qs(url.query)['channel'][0]
                route.fulfill(content_type='text/html; charset=utf-8', body=bridge.replace('<?= bridgeSession ?>',channel))
            else:
                route.abort()

        context.route('**/*', route_request)
        page.goto(HOST+'/-/#access_key='+'A'*43, wait_until='commit')
        page.wait_for_function("""() => ['entry-search','entry-import-source','entry-view-settings']
            .every(id=>document.getElementById(id)?.checkVisibility())""")
        paint = "()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(Math.round(performance.now())))))"
        first = page.evaluate(paint)
        page.locator('#entry-view-segments').click()
        expect(page.locator('#entry-segment-fields')).to_be_visible()
        page.locator('#entry-view-sources').click()
        page.locator('#entry-search').fill('Тест')
        assert bundles and directories
        request = directories.pop(0)
        now = datetime.now(timezone.utc)
        sources = [{'id':'source-companies','name':'Тестовый каталог','url':'https://example.invalid/untrusted',
                    'origin':{'name':'Непроверенная исходная база'},'status':'Служебное значение'}, {'id':'other-source-file','name':'Архив'}]
        segments = [{'id':'test-segment-id','name':'Тестовый сегмент','project':'numshield','section':'clients','contactCount':219}]
        docs = [{'found':{'name':name,'fields':{'schema':{'integerValue':'1'},
            'generatedAt':{'timestampValue':now.isoformat()},'expiresAt':{'timestampValue':(now+timedelta(minutes=5)).isoformat()},
            'rowsJson':{'stringValue':json.dumps(rows)}}}} for name,rows in zip(request.request.post_data_json['documents'],[sources,segments])]
        request.fulfill(content_type='application/json',headers={'Access-Control-Allow-Origin':HOST},body=json.dumps(docs))
        expect(page.locator('#entry-preview-list button')).to_have_text('Тестовый каталог')
        first_row=page.locator('#entry-preview-list li')
        expect(first_row).to_have_text('Тестовый каталогОткрыть на Диске')
        expect(first_row.get_by_role('link')).to_have_attribute('href','https://drive.google.com/open?id=source-companies')
        expect(first_row.get_by_role('link')).to_have_attribute('target','_blank')
        page.locator('#entry-view-segments').click()
        expect(first_row).to_have_text('Тестовый сегмент')
        expect(first_row.get_by_role('button')).to_have_count(1)
        page.locator('#entry-view-sources').click()
        page.locator('#entry-search').focus()

        release_scripts = True
        started = page.evaluate('performance.now()')
        for route in bundles:
            route.fulfill(content_type='text/javascript; charset=utf-8', body=asset)
        app = page.frame(url=HOST+'/-/app.html')
        app.wait_for_function('!!window.RegistryGrid && !!window.RegistrySegmentCard')
        google = next(frame for frame in page.frames if urlsplit(frame.url).hostname=='script.google.com')
        google.wait_for_function("backend.pending.some(p=>p.method==='getAppBootstrap')")
        expect(page.locator('#entry-preview')).to_be_hidden()
        field = app.locator('#br-source-search')
        expect(field).to_have_value('Тест')
        app.wait_for_function("document.activeElement===document.getElementById('br-source-search')")
        after_bundle = page.evaluate(paint) - started
        app.locator('#br-view-segments').click()
        expect(app.locator('#br-segment-category-clients')).to_be_visible()
        app.locator('#br-view-sources').click()
        expect(field).to_have_value('Тест')
        google.evaluate("backend.holdMethods=[]; releaseRpc('getAppBootstrap')")
        google.wait_for_function("backend.sourceGets>0")
        expect(field).to_have_value('Тест')
        assert not errors, errors
        print(f'Cold local Pages: fields/actions painted {first} ms; released bundle to interactive handoff {after_bundle:.0f} ms; '
              'search/focus and navigation verified while Google bootstrap was held.', flush=True)
        browser.close()


if __name__ == '__main__':
    main()
