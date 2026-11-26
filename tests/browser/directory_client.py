"""Authorized startup directories and delayed Google responses; synthetic origins only."""
import sys

sys.dont_write_bytecode = True
from playwright.sync_api import expect, sync_playwright
from performance_client import FIXTURE, HTML, ROOT
from segment_card import DATA as CARD_DATA

ORIGIN = 'https://seainkk.github.io'
HOST = """<script>
window.acks=[];
onmessage=e=>{if(e.origin!==location.origin||e.source!==document.querySelector('iframe')?.contentWindow)return;
 if(e.data.type==='bases-registry-directory-scope')window.scope=e.data;
 else window.acks.push(e.data);};
window.send=m=>document.querySelector('iframe').contentWindow.postMessage({...scope,...m},location.origin);
</script><iframe src="./app.html" style="width:100vw;height:90vh"></iframe>"""
ADAPTER = """
backend.holdMethods=['getAppBootstrap','getSegmentsDashboard','getSourceBases','getSegmentDirectory','getGridWorkbook'];
window.RegistryPagesTransport={run:(method,payload,projectId,accessKey)=>new Promise((resolve,reject)=>
  google.script.run.withSuccessHandler(resolve).withFailureHandler(reject).callApp({method,payload,projectId,accessKey}))};
"""


def main():
    app_html = HTML.replace(FIXTURE, FIXTURE + CARD_DATA + ADAPTER, 1)
    for part in ('SegmentCardPanel','SegmentCardClient','SegmentSelectionsClient','GridPanel','GridClient','WorkbookMailingClient'):
        app_html = app_html.replace("<?!= include_('"+part+"'); ?>", (ROOT/'src'/(part+'.html')).read_text(encoding='utf-8'))
    with sync_playwright() as pw:
        launch = {'channel':'chrome'} if sys.platform == 'win32' else {'executable_path':'/usr/bin/chromium'}
        browser = pw.chromium.launch(**launch, headless=True)
        context = browser.new_context()
        def serve(route):
            if route.request.url == ORIGIN+'/-/app.html':
                route.fulfill(content_type='text/html; charset=utf-8',body=app_html)
            elif route.request.url.startswith(ORIGIN+'/-/'):
                route.fulfill(content_type='text/html; charset=utf-8',body=HOST)
            else:
                route.abort()
        context.route('**/*',serve)
        host = context.new_page()
        errors = []
        host.on('pageerror',lambda e: errors.append(str(e)))

        def boot():
            if host.url.startswith(ORIGIN):
                host.evaluate("localStorage.removeItem('registry.activeProject')")
            host.goto('about:blank')
            host.goto(ORIGIN+'/-/#access_key='+'A'*43)
            host.wait_for_function('window.scope?.projectId==="numshield"')
            frame = host.frame(url=ORIGIN+'/-/app.html')
            frame.wait_for_function("backend.pending.some(p=>p.method==='getAppBootstrap')")
            return frame

        def send(message):
            host.evaluate('m=>send(m)',message)

        def offer(kind,items,**fields):
            send(dict(type='bases-registry-fast-directory',kind=kind,items=items,
                      checkedAt=1700000000000,complete=True,**fields))

        def choose(kind,id,serial):
            send(dict(type='bases-registry-fast-open',kind=kind,id=id,serial=serial))

        def finish(frame,method):
            frame.evaluate("m=>{backend.holdMethods=backend.holdMethods.filter(x=>x!==m);releaseRpc(m)}",method)

        try:
            app = boot()
            source = {'id':'source-companies','name':'База из каталога'}
            offer('sources',[source],projectId='neosender')
            offer('sources',[source])
            expect(app.locator('#br-sources-items .br-catalog-name')).to_have_count(1)
            expect(app.locator('#br-sources-items')).to_contain_text(source['name'])
            expect(app.locator('#br-source-search')).to_be_visible()
            expect(app.locator('#br-import-open')).to_be_enabled()
            app.locator('#br-import-open').click()
            expect(app.locator('#br-import-panel')).to_be_visible()
            expect(app.locator('#br-upload-submit')).to_be_disabled()
            app.locator('#br-import-cancel').click()
            app.locator('#br-settings-open').click()
            expect(app.locator('#br-settings-dialog')).to_be_visible()
            expect(app.locator('#br-share-copy')).to_be_disabled()
            app.locator('#br-settings-close').click()
            for view in ('analytics','infrastructure','retarget','sources'):
                app.locator('#br-view-'+view).click()
                expect(app.locator('#br-view-'+view)).to_have_attribute('aria-pressed','true')
            expect(app.locator('#br-source-search')).to_be_visible()
            choose('sources',source['id'],1)
            choose('sources',None,2)
            finish(app,'getAppBootstrap')
            app.wait_for_function("backend.pending.some(p=>p.method==='getSourceBases')")
            old_catalog = {'checkedAt':app.evaluate('Date.now()-1000'),'items':[{'name':'Устаревшая база','contents':[]}]}
            for kind in ('bases-registry-startup-catalog','bases-registry-saved-catalog'):
                host.evaluate("window.acks=[]")
                send(dict(type=kind,**old_catalog))
                host.wait_for_function("acks.some(m=>m.type==='bases-registry-startup-catalog-presented'&&m.visible)")
                expect(app.locator('body')).not_to_contain_text('Устаревшая база')
            assert not app.evaluate("backend.calls.some(c=>c.name==='getGridWorkbook'||c.name==='getSourceDirectory')")
            # A spreadsheet opens using only its confirmed MIME, while the full catalog remains held.
            choose('sources',source['id'],3)
            choose('sources',source['id'],3)
            app.wait_for_function("backend.pending.some(p=>p.method==='getGridWorkbook')")
            assert app.evaluate("backend.calls.filter(c=>c.name==='getGridWorkbook').length===1")
            host.wait_for_function("acks.some(m=>m.type==='bases-registry-fast-opened'&&m.serial===3)")
            send(dict(type='bases-registry-fast-view',kind='segments',serial=1))
            host.wait_for_function("acks.some(m=>m.type==='bases-registry-fast-viewed'&&!m.visible)")

            app = boot()
            segment = {'id':'existing-segment','name':'Выбранный сегмент','category':'clients'}
            send(dict(type='bases-registry-fast-view',kind='segments',serial=2))
            send(dict(type='bases-registry-fast-view',kind='sources',serial=1))
            host.wait_for_function("acks.some(m=>m.type==='bases-registry-fast-viewed'&&m.kind==='segments'&&m.visible)")
            expect(app.locator('#br-view-segments')).to_have_attribute('aria-pressed','true')
            offer('segments',[])
            expect(app.locator('#br-segments-empty-title')).to_contain_text('пока нет сегментов')
            send(dict(type='bases-registry-fast-expired',kind='segments',checkedAt=1700000000000))
            expect(app.locator('#br-segments-empty-title')).to_contain_text('Загружаем сегменты')
            send(dict(type='bases-registry-fast-directory',kind='segments',complete=False,checkedAt=1700000000001,items=[]))
            expect(app.locator('#br-segments-empty-title')).to_contain_text('Уточняем список')
            send(dict(type='bases-registry-fast-directory',kind='segments',complete=True,checkedAt=1700000000002,items=[segment]))
            send(dict(type='bases-registry-fast-expired',kind='segments',checkedAt=1700000000001))
            expect(app.locator('#br-segments-rows')).to_contain_text(segment['name'])
            app.evaluate("""() => {
              const normal=api.getSegmentContactCard;
              api.getSegmentContactCard=p=>{const page=normal(p);page.rows=page.rows.slice(0,1);page.nextOffset=1;return page;};
            }""")
            choose('segments',segment['id'],1)
            choose('segments',segment['id'],1)
            # The card RPC authorizes independently; its first page stays out of the DOM until bootstrap.
            app.wait_for_function("backend.calls.some(c=>c.name==='getSegmentContactCard')&&backend.active===1")
            expect(app.locator('#sc-rows tr')).to_have_count(0)
            finish(app,'getAppBootstrap')
            expect(app.locator('#sc-rows')).to_contain_text('both@example.test')
            expect(app.locator('#sc-rows tr')).to_have_count(1)
            expect(app.locator('#sc-next')).to_be_enabled()
            assert app.evaluate("backend.calls.filter(c=>c.name==='getSegmentContactCard').length===1")
            assert app.evaluate("!backend.calls.some(c=>['getSegmentDirectory','getSegmentsDashboard','getSourceBases'].includes(c.name)) && backend.maxActiveReads===2")
            host.wait_for_function("acks.some(m=>m.type==='bases-registry-fast-opened'&&m.serial===1)")
            old_epoch = host.evaluate("scope.epoch")
            app.locator('#br-action-back').click()
            app.locator('#br-project').select_option('neosender')
            host.wait_for_function("scope.projectId==='neosender'")
            send(dict(type='bases-registry-fast-directory',kind='segments',epoch=old_epoch,projectId='numshield',
                      complete=True,checkedAt=1700000000000,items=[dict(segment,name='Чужой проект')]))
            expect(app.locator('body')).not_to_contain_text('Чужой проект')

            app = boot()
            offer('segments',[segment])
            choose('segments',segment['id'],1)
            app.wait_for_function("backend.calls.some(c=>c.name==='getSegmentContactCard')&&backend.active===1")
            app.evaluate("backend.revoked=true")
            finish(app,'getAppBootstrap')
            expect(app.locator('.br-main')).to_be_hidden()
            expect(app.locator('#sc-rows tr')).to_have_count(0)
            assert app.evaluate("backend.calls.filter(c=>c.name==='getSegmentContactCard').length===1 && !backend.calls.some(c=>c.name==='getSourceBases')")

            app = boot()
            app.evaluate("() => {api.getSegmentContactCard=()=>{throw new Error('[OUTSIDE_PROJECT] Сегмент перемещён')};}")
            offer('segments',[segment])
            choose('segments',segment['id'],1)
            app.wait_for_function("backend.calls.some(c=>c.name==='getSegmentContactCard')&&backend.active===1")
            finish(app,'getAppBootstrap')
            expect(app.locator('#sc-status')).to_contain_text('Сегмент перемещён')
            expect(app.locator('#sc-rows tr')).to_have_count(0)
            assert app.evaluate("backend.calls.filter(c=>c.name==='getSegmentContactCard').length===1")

            for cancel in (True,False):
                app = boot()
                app.evaluate("backend.holdMethods.push('getSegmentContactCard')")
                offer('segments',[segment])
                choose('segments',segment['id'],1)
                app.wait_for_function("backend.pending.some(p=>p.method==='getSegmentContactCard')")
                if cancel:
                    choose('segments',None,2)
                finish(app,'getAppBootstrap')
                if cancel:
                    expect(app.locator('#br-segments-view')).to_be_visible()
                else:
                    expect(app.locator('#sc-view')).to_be_visible()
                    app.locator('#br-project').select_option('neosender')
                    host.wait_for_function("scope.projectId==='neosender'")
                finish(app,'getSegmentContactCard')
                expect(app.locator('#sc-rows tr')).to_have_count(0)
                assert app.evaluate("backend.calls.filter(c=>c.name==='getSegmentContactCard').length===1")
            assert not errors,errors
        finally:
            context.close()
            browser.close()
    print('PASS: scoped directories, early click, cancellation, pending catalog, project changes and revocation.')


if __name__ == '__main__':
    main()
