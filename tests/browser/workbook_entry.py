"""Exercise the native Sheets dialog and its embedded Pages app offline."""
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


def main():
    root = Path(__file__).resolve().parents[2]
    pages = (root / 'entry/index.html').read_text(encoding='utf-8')
    client = (root / 'src/Client.html').read_text(encoding='utf-8')

    def functions(*names):
        # Top-level client functions use two spaces of indentation.
        return '\n'.join(re.search(r'^  function ' + name +
                        r'\(.*?(?=\n  (?:async )?function |\n  window\.addEventListener)', client,
                        re.MULTILINE | re.DOTALL).group(0) for name in names)

    script = functions('entryWindow', 'postEntryMessage', 'notifyEntry', 'receiveEntryMessage', 'openGridWorkbook', 'openEntryWorkbook')
    leaf = """<!doctype html><meta charset=utf-8><output id=result></output><button id=download hidden>CSV</button><script>
      let accessReady=true,activeProjectId='numshield';
      const projectNames={numshield:'Намшилд',neosender:'Нео Сендер'},select={value:''};
      const $=()=>select,switchProject=()=>{activeProjectId=select.value};
      const importing=false,sourceSaving=false,segmentSaving=false,segmentEditor=null,coldySession=null,providerSession=null,coldyMailings=null;
      const workspaceRpc=()=>{},armViewTimer=()=>{},updateControls=()=>{};
      const button=document.getElementById('download');
      window.RegistryGrid={open(options){
        const action=options.workbookAction;
        document.querySelector('output').value=[options.id,options.projectId,action,options.validateNew].join('/');
        if(action==='telegramReady'||action==='telegramAddressBook'){
          button.hidden=false;button.dataset.action=action;
          button.textContent=action==='telegramReady'?'Скачать готовые контакты':'Скачать для записной книжки';
        }
      }};
    """ + script + """
      window.addEventListener('message',receiveEntryMessage);
      notifyEntry('ready');
      document.getElementById('download').onclick=()=>{
        const link=document.createElement('a');
        link.download=button.dataset.action+'.csv';link.href=URL.createObjectURL(new Blob(['contact\\n@sample_test'],{type:'text/csv'}));
        document.body.append(link);link.click();link.remove();
      };
    </script>"""
    pages_url = 'https://seainkk.github.io/-/?validate=synthetic_company_book&project=neosender&action='
    entry_url = 'https://docs.google.com/spreadsheets/d/synthetic'
    def frame(src, sandboxed=False):
        flags = 'allow-same-origin allow-forms allow-scripts allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox'
        sandbox = (' sandbox="' + flags + '"') if sandboxed else ''
        return '<!doctype html><iframe referrerpolicy="no-referrer"' + sandbox + ' src="' + src + '"></iframe>'

    def serve(route):
        request = urlsplit(route.request.url)
        host = request.hostname
        action = request.path.rsplit('/', 1)[-1]
        contents = {
            'docs.google.com': frame('https://dialog-script.googleusercontent.com/native/' + action, True),
            'dialog-script.googleusercontent.com': frame((pages_url + action).replace('&','&amp;')),
            'seainkk.github.io': leaf if request.path == '/-/app.html' else pages,
        }
        if host in contents and route.request.resource_type == 'document':
            route.fulfill(status=200, content_type='text/html; charset=utf-8', body=contents[host])
        else:
            route.abort()

    with sync_playwright() as pw:
        launch = {'channel': 'chrome'} if sys.platform == 'win32' else {'executable_path': '/usr/bin/chromium'}
        browser = pw.chromium.launch(**launch, headless=True)
        context = browser.new_context()
        context.route('**/*', serve)
        for action, label in [('mailing', None), ('email', None), ('telegramReady','Скачать готовые контакты'),
                              ('telegramAddressBook','Скачать для записной книжки')]:
            page = context.new_page()
            page.goto(entry_url + '/' + action)
            dialog = page.frame_locator('iframe').frame_locator('iframe')
            dialog.locator('#entry-private-link').fill('https://seainkk.github.io/-/#access_key=' + 'A'*43)
            dialog.locator('button[type=submit]').click()
            app = dialog.frame_locator('#entry-frame-host iframe')
            expect(app.locator('output')).to_have_text('synthetic_company_book/neosender/' + action + '/false')
            expect(dialog.locator('body')).to_have_attribute('data-state', 'ready')
            if label:
                with page.expect_download() as observed:
                    app.get_by_role('button', name=label, exact=True).click()
                download = observed.value
                assert download.suggested_filename == action + '.csv'
                assert download.path().read_bytes() == b'contact\n@sample_test'
            else:
                expect(app.locator('#download')).to_be_hidden()
            page.close()
        browser.close()
    print('Nested Sheets workbook action passed.')


if __name__ == '__main__':
    main()
