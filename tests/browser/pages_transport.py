"""Offline Pages → credentialless Google iframe RPC, including both real File/DOM form layouts."""
from html import escape
from pathlib import Path
import sys
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright


def main():
    root = Path(__file__).resolve().parents[2]
    transport = (root / 'src/PagesTransport.html').read_text(encoding='utf-8')
    bridge = (root / 'src/PagesBridge.html').read_text(encoding='utf-8')
    # Mimic the two Apps Script entry points. FormData reads the real File after the partition boundary.
    mock = """<script>
      window.google={script:{run:{withSuccessHandler(done){return {withFailureHandler(fail){return {
        callApp(request){if(request.method==='testError')fail(new Error('[SOURCE_CHANGED] test '+request.accessKey));
          else done({method:request.method,project:request.projectId,authenticated:request.accessKey==='Z'.repeat(43),payload:request.payload});},
        async uploadSourceBase(form){
          try{
            const data=new FormData(form),file=data.get('file');
            if(!(form instanceof HTMLFormElement)||!form.isConnected||!(file instanceof File))throw Error('missing native form or file');
            done({name:file.name,mime:file.type,bytes:Array.from(new Uint8Array(await file.arrayBuffer())),lastModified:file.lastModified,
              authenticated:data.get('accessKey')==='Z'.repeat(43),project:data.get('projectId'),
              fields:[...data].filter(([name])=>!['accessKey','projectId','file'].includes(name))});
          }catch(e){fail(e);}
        }
      };}};}}}};
    </script>"""
    host = 'https://seainkk.github.io'
    flags = 'allow-same-origin allow-forms allow-scripts allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox'
    def iframe(url, sandbox=False):
        attrs = f' sandbox="{flags}"' if sandbox else ''
        return '<!doctype html><iframe referrerpolicy="no-referrer"' + attrs + ' src="' + escape(url, quote=True) + '"></iframe>'

    def serve(route):
        url = urlsplit(route.request.url)
        channel = parse_qs(url.query).get('channel', [''])[0]
        body = None
        if url.hostname == 'docs.google.com':
            body = iframe('https://dialog-script.googleusercontent.com/native', True)
        elif url.hostname == 'dialog-script.googleusercontent.com':
            body = iframe(host + '/-/')
        elif url.hostname == 'seainkk.github.io':
            body = iframe(host + '/-/app.html') if url.path == '/-/' else '<!doctype html><body>' + transport
        elif url.hostname == 'script.google.com':
            assert 'access_key' not in url.query and 'Z'*43 not in route.request.url
            assert parse_qs(url.query).get('bridge') == ['1'] and len(channel) == 36
            body = iframe('https://app-script.googleusercontent.com/gas?channel=' + channel, True)
        elif url.hostname == 'app-script.googleusercontent.com':
            body = bridge.replace('<?= bridgeSession ?>', escape(channel, quote=True)).replace('<script>', mock+'<script>',1)
        if body is None or route.request.resource_type != 'document':
            route.abort()
        else:
            route.fulfill(status=200, content_type='text/html; charset=utf-8', body=body)

    with sync_playwright() as pw:
        launch = {'channel':'chrome'} if sys.platform == 'win32' else {'executable_path':'/usr/bin/chromium'}
        browser = pw.chromium.launch(**launch, headless=True)
        context = browser.new_context()
        context.route('**/*',serve)
        page = context.new_page()
        page.goto('https://docs.google.com/spreadsheets/d/synthetic')
        app = page.frame(url=host + '/-/app.html')
        app.wait_for_function('!!window.RegistryPagesTransport')
        response = app.evaluate("""async() => {
          const transport=window.RegistryPagesTransport, key='Z'.repeat(43);
          return await transport.run('getAppBootstrap',{includeSourcePreview:true},'neosender',key);
        }""")
        assert response == {'method':'getAppBootstrap','project':'neosender','authenticated':True,'payload':{'includeSourcePreview':True}}
        err = app.evaluate("""async() => {
          try{await RegistryPagesTransport.run('testError',{},'numshield','Z'.repeat(43));}
          catch(e){return e.message;}
        }""")
        assert '[SOURCE_CHANGED]' in err and 'Z'*43 not in err
        for prepared in (True,False):
            project = 'neosender' if prepared else 'numshield'
            fields = {'name':'Синтетика','requestId':'request-synthetic','status':'ready'}
            fields.update({'flow':'prepared','section':'lpr','routeMode':'auto'} if prepared else {'contentsJSON':'["companies"]'})
            result = app.evaluate("""async ({project,fields})=>{
              const form=document.createElement('form');
              for(const [name,value] of Object.entries({...fields, accessKey:'wrong-hidden-key', projectId:'wrong-project'})){
                const field=document.createElement('input');field.name=name;field.value=value;form.append(field);
              }
              const data=new DataTransfer(), file=new File([new Uint8Array([0,255,16,13,10])],'синтетика.xlsx',
                {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',lastModified:1234});
              data.items.add(file);const input=document.createElement('input');input.name='file';input.type='file';input.files=data.files;form.append(input);
              return await RegistryPagesTransport.upload(form,project,'Z'.repeat(43));
            }""",{'project':project,'fields':fields})
            assert dict(result['fields']) == fields and result['authenticated'] and result['project'] == project
            assert result['name'] == 'синтетика.xlsx' and result['bytes'] == [0,255,16,13,10] and result['lastModified'] == 1234
            assert result['mime'] == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        gas = next(f for f in page.frames if urlsplit(f.url).hostname == 'app-script.googleusercontent.com')
        expect(gas.locator('form')).to_have_count(0)
        browser.close()
    print('Pages bridge RPC and both native upload forms passed.')


if __name__ == '__main__':
    main()
