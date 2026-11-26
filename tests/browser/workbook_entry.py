"""Exercise the native Sheets dialog and its cross-origin Pages and Apps Script frames offline."""
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

    script = functions('entryWindow', 'postEntryMessage', 'notifyEntry', 'receiveEntryMessage', 'openEntryWorkbook')
    leaf = """<!doctype html><meta charset=utf-8><output id=result></output><script>
      let accessReady=true,activeProjectId='numshield';
      const projectNames={numshield:'Намшилд',neosender:'Нео Сендер'},select={value:''};
      const $=()=>select,switchProject=()=>{activeProjectId=select.value};
      function openGridWorkbook(id,validateNew,action){ document.querySelector('output').value=[id,activeProjectId,action,validateNew].join('/'); }
    """ + script + """
      window.addEventListener('message',receiveEntryMessage);
      notifyEntry('ready');
    </script>"""
    pages_url = 'https://seainkk.github.io/-/?validate=synthetic_company_book&action=mailing&project=neosender'
    entry_url = 'https://docs.google.com/spreadsheets/d/synthetic'
    frame = lambda src: '<!doctype html><iframe referrerpolicy="no-referrer" src="' + src + '"></iframe>'

    def serve(route):
        host = urlsplit(route.request.url).hostname
        contents = {
            'docs.google.com': frame('https://dialog-script.googleusercontent.com/native'),
            'dialog-script.googleusercontent.com': frame(pages_url.replace('&','&amp;')),
            'seainkk.github.io': pages,
            'script.google.com': frame('https://app-script.googleusercontent.com/leaf'),
            'app-script.googleusercontent.com': leaf,
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
        page = context.new_page()
        page.goto(entry_url)
        dialog = page.frame_locator('iframe').frame_locator('iframe')
        dialog.locator('#entry-private-link').fill('https://seainkk.github.io/-/#access_key=' + 'A'*43)
        dialog.locator('button[type=submit]').click()
        result = dialog.frame_locator('#entry-frame-host iframe').frame_locator('iframe').locator('output')
        expect(result).to_have_text('synthetic_company_book/neosender/mailing/false')
        expect(dialog.locator('body')).to_have_attribute('data-state', 'ready')
        browser.close()
    print('Nested Sheets workbook action passed.')


if __name__ == '__main__':
    main()
