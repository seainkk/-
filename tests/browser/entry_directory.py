"""Offline Chrome check of the first document while both the static app and Firestore are delayed."""
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


def main():
    root = Path(__file__).resolve().parents[2]
    host = 'https://seainkk.github.io'
    test_key = 'Z' * 43
    with TemporaryDirectory() as output, sync_playwright() as driver:
        subprocess.run(['node','scripts/build-pages.mjs',output],cwd=root,check=True,
                       env={**os.environ,'FIREBASE_DIRECTORY_PROJECT':'directory-test'})
        index = (Path(output)/'index.html').read_text(encoding='utf8')
        chrome={'channel':'chrome'} if sys.platform=='win32' else {'executable_path':'/usr/bin/chromium'}
        browser=driver.chromium.launch(**chrome,headless=True)
        page=browser.new_page()
        pending={}
        def handle(route):
            url=urlsplit(route.request.url)
            if url.hostname=='seainkk.github.io' and url.path=='/-/':
                route.fulfill(content_type='text/html',body=index)
            elif url.hostname=='seainkk.github.io' and url.path=='/-/app.html':
                pending['app']=route
            elif url.hostname=='firestore.googleapis.com':
                assert route.request.method=='POST' and 'directoryViews' not in url.path
                assert route.request.headers['content-type'].startswith('text/plain')
                pending['directory']=route
            else:
                route.abort()
        page.route('**/*',handle)
        page.goto(host+'/-/#access_key='+test_key,wait_until='commit')
        segments=page.locator('#entry-view-segments');expect(segments).to_be_visible()
        segments.click()
        deadline=time.monotonic()+10
        while time.monotonic()<deadline and ('directory' not in pending or 'app' not in pending):
            page.wait_for_timeout(10)
        assert 'directory' in pending and 'app' in pending
        request=pending['directory']
        address=request.request.post_data_json['documents']
        assert all(test_key not in name for name in address)
        stamp=datetime.now(timezone.utc)
        rows=[[{'id':'source_test_001','name':'Синтетическая база'}],[{'id':'segment_test_001','name':'Синтетический сегмент','project':'numshield','section':'clients'}]]
        docs=[{'found':{'name':name,'fields':{'schema':{'integerValue':'1'},'generatedAt':{'timestampValue':stamp.isoformat()},
              'expiresAt':{'timestampValue':(stamp+timedelta(minutes=10)).isoformat()},'rowsJson':{'stringValue':json.dumps(items)}}}} for name,items in zip(address,rows)]
        request.fulfill(content_type='application/json',headers={'Access-Control-Allow-Origin':host},body=json.dumps(docs))
        segment=page.locator('#entry-preview-list [data-directory-kind=segments]')
        expect(segment).to_have_text('Синтетический сегмент')
        page.locator('#entry-view-sources').click()
        expect(page.locator('#entry-preview-list [data-directory-kind=sources]')).to_have_text('Синтетическая база')
        segments.click();segment.click()
        pending['app'].fulfill(content_type='text/html',body="""<script>
          window.messages=[];
          window.addEventListener('message',e=>{if(e.origin===location.origin)window.messages.push(e.data)});
          parent.postMessage({type:'bases-registry-shell'},location.origin);
          parent.postMessage({type:'bases-registry-directory-scope',epoch:1,projectId:'numshield'},location.origin);
        </script>""")
        frame=page.frame_locator('#entry-frame-host iframe')
        expect(frame.locator('script')).to_have_count(1)
        app=next(f for f in page.frames if urlsplit(f.url).path=='/-/app.html')
        app.wait_for_function("window.messages?.some(m=>m.type==='bases-registry-fast-open')")
        expect(segment).to_be_visible()
        app.evaluate("""()=>{
          for(const m of messages){
            if(m.type.endsWith('-view'))parent.postMessage({...m,type:'bases-registry-fast-viewed',visible:true},location.origin);
            if(m.kind==='segments'&&m.type.endsWith('-directory'))parent.postMessage({...m,type:'bases-registry-fast-presented',visible:true},location.origin);
          }
        }""")
        expect(page.locator('#entry-preview')).to_be_hidden()
        assert app.evaluate("messages.filter(m=>m.type==='bases-registry-fast-open').length") == 1
        browser.close()
        print('Cold Pages navigation, verified rows before iframe, and acknowledged handoff passed.',flush=True)


if __name__=='__main__':
    main()
