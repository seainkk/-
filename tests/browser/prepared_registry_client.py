"""Three-sheet import preview and registry-section checks against fake RPCs only."""
from pathlib import Path
import sys
from playwright.sync_api import expect, sync_playwright
ROOT=Path(__file__).resolve().parents[2]
FIXTURE=Path(__file__).with_name('performance-fixture.js').read_text()
GRID_STUB="""window.RegistryGrid={opened:[],open(o){this.opened.push(o.id);this.transport=o.transport;this.closed=o.onClose;this.openedNow=true;},isOpen(){return !!this.openedNow;},hasPending(){return false;},lock(){this.openedNow=false;this.locked=true;}};"""
HTML=(ROOT/'src/Index.html').read_text().replace("<?!= include_('Styles'); ?>",(ROOT/'src/Styles.html').read_text()).replace("<?!= include_('Client'); ?>",'<script>'+FIXTURE+GRID_STUB+'</script>'+(ROOT/'src/Client.html').read_text())

def check_source_card(page):
    card = page.locator('[data-source-id="source-companies"]')
    summary = card.locator('.br-source-settings > summary')
    status = card.locator('[data-source-field="status"]')
    badge = card.locator('.br-source-status')

    expect(summary).to_have_text('Настройки базы')
    expect(status).to_be_hidden()
    expect(card.locator('h2')).to_be_visible()
    expect(badge).to_have_text('Готова')
    expect(card.locator('[data-grid-source]')).to_be_visible()
    expect(card.locator('[data-preview-source]')).to_be_visible()
    expect(card.locator('[data-add-source]')).to_be_enabled()
    expect(card.get_by_role('link', name='Существующий сегмент')).to_be_visible()

    summary.press('Enter')
    expect(status).to_be_visible()
    status.press('ArrowDown')
    expect(status).to_have_value('rework')
    expect(status).to_be_focused()
    expect(card.locator('[data-add-source]')).to_be_disabled()
    expect(page.locator('[data-source-id="source-mixed"] [data-source-field="status"]')).to_be_hidden()
    card.locator('[data-source-cancel]').click()
    expect(status).to_have_value('ready')
    expect(card.locator('[data-add-source]')).to_be_enabled()
    assert not page.evaluate("backend.calls.some(call => call.name === 'updateSourceBase')")

    status.press('ArrowUp')
    expect(status).to_have_value('collection')
    card.locator('[data-source-save]').click()
    expect(badge).to_have_text('Сбор')
    expect(card.locator('[data-add-source]')).to_be_disabled()
    assert page.evaluate("backend.calls.filter(call => call.name === 'updateSourceBase').length") == 1
    summary.click()
    expect(status).to_be_hidden()
    expect(badge).to_be_visible()

def check_lineage(page):
    original = 'https://docs.google.com/spreadsheets/d/original_sheet_fixture/edit'
    card = page.locator('[data-source-id="source-companies"]')
    panel = page.locator('#br-source-lineage')
    panel.locator('summary').click()
    rows = page.locator('#br-lineage-rows tr')
    expect(rows).to_have_count(5)
    target = rows.filter(has_text='Готовая база компаний')
    expect(target.locator('td').first).to_have_text('Не указан')
    expect(target.get_by_role('link',name='Существующий сегмент')).to_be_visible()
    # This overview includes both registry sections and all selections of one original.
    expect(rows.filter(has_text='Готовая база ЛПР')).to_have_count(1)
    card.locator('.br-source-settings > summary').click()
    attach = card.get_by_role('button',name='Привязать исходную базу')
    attach.click()
    expect(page.locator('#br-origin-dialog')).to_be_visible()
    page.locator('#br-origin-url').fill(original+'?gid=42')
    page.locator('#br-origin-name').fill('Один исходник')
    page.locator('#br-origin-criteria').fill('Два региона')
    page.locator('#br-origin-save').click()
    expect(page.locator('#br-origin-dialog')).to_be_hidden()
    expect(target.get_by_role('link',name='Один исходник')).to_have_attribute('href',original)
    expect(target.locator('td').nth(2)).to_have_text('Два региона')
    expect(target.get_by_role('link',name='Существующий сегмент')).to_be_visible()
    expect(rows.filter(has_text='Один исходник')).to_have_count(2)
    expect(rows.filter(has_text='Готовая база ЛПР')).to_contain_text('Без сегмента')
    expect(attach).to_have_count(0)

def main():
 with sync_playwright() as p:
  launch={'channel':'chrome'} if sys.platform=='win32' else {'executable_path':'/usr/bin/chromium'}
  browser=p.chromium.launch(**launch,headless=True,args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1440,'height':1100});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  def reset(saved=None,boot=''):
   import json
   init=boot+('backend.preparedDrafts='+json.dumps(saved)+';backend.importCount=1;' if saved else '')
   html=HTML.replace('<script>'+FIXTURE+GRID_STUB+'</script>','<script>'+FIXTURE+GRID_STUB+init+'</script>')
   page.goto('about:blank');page.set_content(html);page.wait_for_selector('[data-source-id="source-companies"]');page.wait_for_function('backend.active===0')
  def idle():page.wait_for_function('backend.active===0')
  def held(method):page.wait_for_function('(m)=>backend.pending.some(p=>p.method===m)',arg=method)
  def release(method):page.evaluate('(m)=>releaseRpc(m)',method)
  def open_catalog():
   page.locator('#br-import-open').click()
   page.locator('#br-import-destination').select_option('catalog')
  def stage_link(name='Кухни',section='companies'):
   if section=='lpr':page.locator('#br-section-lpr').click()
   open_catalog();page.locator('#br-import-mode-link').click();page.locator('#br-link-name').fill(name);page.locator('#br-link-url').fill('https://docs.google.com/spreadsheets/d/source_123456/edit');page.locator('#br-link-submit').click();page.wait_for_selector('#br-prepared-preview:not([hidden])');idle();page.locator('#br-prepared-recalculate').click();page.wait_for_function("document.querySelectorAll('#br-prepared-tabs button').length===3");idle()
  reset(boot="backend.sources[0].segments.push({id:'existing-segment',name:'Существующий сегмент'});backend.sources[2].origin={id:'original_sheet_fixture',name:'Один исходник',criteria:'',url:'https://docs.google.com/spreadsheets/d/original_sheet_fixture/edit'};")
  check_lineage(page)
  reset(boot="backend.sources[0].segments.push({id:'existing-segment',name:'Существующий сегмент'});")
  check_source_card(page)
  assert page.locator('[data-source-id="source-lpr"]').count()==0
  assert page.locator('[data-source-id="source-mixed"]').is_visible()
  page.locator('#br-section-lpr').click();assert page.locator('[data-source-id="source-lpr"]').is_visible();assert page.locator('[data-source-id="source-companies"]').count()==0;assert page.locator('[data-source-id="source-mixed"]').is_visible()
  page.locator('#br-section-companies').click()
  stage_link()
  assert page.evaluate('backend.importCount')==0,'Preview must not publish or create final file'
  assert page.locator('#br-prepared-tabs button').all_text_contents()==['Исходная база','Email','Телефоны']
  assert page.locator('#br-prepared-confirm').is_enabled()
  assert page.evaluate("backend.calls.filter(c=>c.name==='stagePreparedBaseLink').at(-1).p.section")=='companies'
  page.locator('#br-prepared-tabs button').nth(2).click();assert '+79990000001' in page.locator('#br-prepared-table').inner_text();assert 'WhatsApp' in page.locator('#br-prepared-table').inner_text()
  page.locator('#br-prepared-sheet').select_option('7');idle();page.wait_for_function("document.querySelector('#br-prepared-confirm').disabled===false")
  assert page.evaluate("backend.calls.filter(c=>c.name==='previewPreparedBase').at(-1).p.sheetId")==7
  page.evaluate("backend.holdMethods=['confirmPreparedBase','getSourceBases']")
  page.locator('#br-prepared-confirm').click();held('confirmPreparedBase')
  page.locator('#br-prepared-confirm').evaluate('b=>b.click()');assert page.evaluate("backend.calls.filter(c=>c.name==='confirmPreparedBase').length")==1
  release('confirmPreparedBase');page.wait_for_selector('#br-import-panel',state='hidden');assert 'Таблица создана' in page.locator('#br-notice').inner_text();assert page.locator('[data-source-id="prepared-source-1"]').is_visible()
  held('getSourceBases');assert page.locator('[data-grid-source="prepared-source-1"]').first.is_enabled();release('getSourceBases');idle()
  page.locator('[data-grid-source="prepared-source-1"]').first.click();assert page.evaluate('RegistryGrid.opened.at(-1)')=='prepared-source-1'
  page.evaluate("RegistryGrid.lock=function(){this.openedNow=false;this.locked=true;this.closed?.({locked:true});this.accessSeenOnClose=document.getElementById('bases-registry-app').dataset.access;};backend.revoked=true;backend.location.hash='access_key='+'Z'.repeat(43);backend.historyChanged({location:backend.location});")
  page.wait_for_selector('#bases-registry-app[data-access=\"locked\"]')
  assert page.evaluate('RegistryGrid.accessSeenOnClose')=='locked', 'Grid close callback cannot resume the revoked app session'
  assert page.evaluate('backend.maxActiveReads <= 2 && backend.maxActiveWrites <= 1')
  # Blob staging uses the live enabled form and selected single category.
  reset();page.locator('#br-section-lpr').click();open_catalog();page.locator('#br-upload-name').fill('ЛПР кухни');page.locator('#br-upload-file').set_input_files({'name':'people.csv','mimeType':'text/csv','buffer':b'name,email\nAlice,a@example.com'})
  page.evaluate("backend.uploadSerializationDelay=35;backend.holdMethods=['uploadSourceBase']")
  page.locator('#br-upload-submit').click();held('uploadSourceBase')
  dispatch=page.evaluate('backend.dispatches.at(-1)');assert dispatch['form'] and dispatch['args']==1 and dispatch['file'] and dispatch['keyMatches'] and not dispatch['keyDisabled'], 'Deferred native serialization must retain the file and access key'
  assert dispatch['section']=='lpr' and dispatch['name']=='ЛПР кухни' and dispatch['status']=='collection' and dispatch['flow']=='prepared'
  assert dispatch['requestId'] and dispatch['disabledFieldsets']==0 and dispatch['inertAtSerialization']
  assert page.locator('#br-upload-submit').is_disabled()
  assert page.locator('#br-import-file-form').evaluate('form=>form.inert')
  page.evaluate('backend.holdMethods=[]');release('uploadSourceBase');page.wait_for_selector('#br-prepared-preview:not([hidden])');idle()
  assert sorted(dispatch['keys'])==['accessKey','file','flow','name','projectId','requestId','section','status']
  assert dispatch['projectId']=='numshield'
  assert page.evaluate("backend.preparedDrafts[Object.keys(backend.preparedDrafts)[0]].stage.section")=='lpr'
  assert page.evaluate('backend.importCount')==0
  draft=page.evaluate('Object.keys(backend.preparedDrafts)[0]');page.locator('#br-import-cancel').click();page.wait_for_selector('#br-import-panel',state='hidden');assert page.evaluate('(id)=>backend.preparedDrafts[id].cancelled',draft)
  # Incomplete analysis cannot confirm and has not created a final book.
  reset();page.evaluate('backend.partialPreparedPreview=true');stage_link();assert page.locator('#br-prepared-confirm').is_disabled();assert page.evaluate('backend.importCount')==0
  # Preview failures can retry without staging/uploading again.
  reset();page.evaluate('backend.failPreparedPreview=true');open_catalog();page.locator('#br-import-mode-link').click();page.locator('#br-link-name').fill('Повтор');page.locator('#br-link-url').fill('https://docs.google.com/spreadsheets/d/source_123456/edit');page.locator('#br-link-submit').click();page.wait_for_selector('#br-prepared-preview:not([hidden])');idle();page.locator('#br-prepared-recalculate').click();page.wait_for_selector('#br-prepared-retry:not([hidden])');idle();page.locator('#br-prepared-retry').click();page.wait_for_function("document.querySelectorAll('#br-prepared-tabs button').length===3");idle();assert page.evaluate('backend.preparedStages')==1
  # A changed source requires new preview and never creates a final book.
  page.evaluate('backend.preparedPreviewVersion++');page.locator('#br-prepared-confirm').click();page.wait_for_selector('#br-prepared-retry:not([hidden])');idle();assert page.evaluate('backend.importCount')==0
  # Unknown completion retries reuse the same request and do not create twice.
  reset();stage_link();page.evaluate('backend.failPreparedAfterCommit=true');page.locator('#br-prepared-confirm').click();page.wait_for_function("document.querySelector('#br-prepared-health').textContent.includes('Ответ потерян')");idle();first_id=page.evaluate("backend.calls.filter(c=>c.name==='confirmPreparedBase').at(-1).p.requestId");assert page.evaluate('backend.importCount')==1;page.locator('#br-prepared-confirm').click();page.wait_for_selector('#br-import-panel',state='hidden');idle();assert page.evaluate('backend.importCount')==1;assert page.evaluate("backend.calls.filter(c=>c.name==='confirmPreparedBase').at(-1).p.requestId")==first_id
  # Chunked creation continues with the same stable request after acknowledgement.
  reset();stage_link();page.evaluate('backend.processingPrepared=true');page.locator('#br-prepared-confirm').click();page.wait_for_selector('#br-import-panel',state='hidden');idle();assert page.evaluate("backend.calls.some(c=>c.name==='continuePreparedBase')")
  # A page reset loses browser memory but a confirmed server job can resume with the same ID.
  reset();stage_link('Продолжить после перезагрузки','lpr');page.evaluate("backend.processingPrepared=true;backend.holdMethods=['continuePreparedBase']");page.locator('#br-prepared-confirm').click();held('continuePreparedBase')
  saved=page.evaluate('JSON.parse(JSON.stringify(backend.preparedDrafts))');request_id=page.evaluate("backend.calls.filter(c=>c.name==='confirmPreparedBase').at(-1).p.requestId")
  reset(saved);page.wait_for_selector('[data-resume-draft]');idle();assert page.evaluate('backend.preparedStages')==0;assert page.evaluate("backend.calls.filter(c=>c.name==='listPreparedJobs').length")==1
  page.locator('[data-resume-draft]').click();page.wait_for_selector('#br-import-panel',state='hidden');idle()
  assert page.evaluate("backend.calls.filter(c=>c.name==='confirmPreparedBase').length")==0
  assert page.evaluate("backend.calls.filter(c=>c.name==='continuePreparedBase').at(-1).p.requestId")==request_id
  assert page.evaluate('backend.importCount')==1
  assert page.locator('#br-prepared-jobs').is_hidden()
  assert page.locator('#br-section-lpr').get_attribute('aria-pressed')=='true'
  page.evaluate('tick(60000)');idle();assert page.evaluate("backend.calls.filter(c=>c.name==='listPreparedJobs').length")==1
  # A job-list error does not prevent ordinary registry use.
  reset(boot='backend.failPreparedJobs=true;');idle();assert page.locator('[data-source-id="source-companies"]').is_visible();assert page.locator('#br-prepared-jobs').is_hidden()
  # Revocation scrubs the resume banner just like other private data.
  reset(saved);page.wait_for_selector('[data-resume-draft]');idle();page.evaluate('backend.revoked=true');page.locator('#br-refresh').click();page.wait_for_selector('#bases-registry-app[data-access="locked"]');assert page.locator('#br-prepared-jobs-list').inner_text()==''
  # Text-only previews are safe and fit narrow screens.
  reset();page.evaluate("(()=>{const normal=api.previewPreparedBase;api.previewPreparedBase=p=>{const r=normal(p);r.sheets[0].headers[0]='<img src=x onerror=window.bad=1>';r.sheets[0].sample[0][0]='<script>window.bad=1</script>';return r;};})()")
  stage_link();assert page.locator('#br-prepared-table img').count()==0;assert page.evaluate('window.bad') is None
  for width in [360,320]:
   page.set_viewport_size({'width':width,'height':900});assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  # Revocation clears staged preview contents and no late result restores them.
  reset();page.evaluate("backend.holdMethods=['previewPreparedBase']");open_catalog();page.locator('#br-import-mode-link').click();page.locator('#br-link-name').fill('Отзыв');page.locator('#br-link-url').fill('https://docs.google.com/spreadsheets/d/source_123456/edit');page.locator('#br-link-submit').click();page.wait_for_selector('#br-prepared-preview:not([hidden])');idle();page.locator('#br-prepared-recalculate').click();held('previewPreparedBase');page.evaluate('backend.revoked=true');release('previewPreparedBase');page.wait_for_selector('#bases-registry-app[data-access="locked"]');idle();assert page.locator('#br-prepared-table').inner_text()=='';assert page.evaluate('RegistryGrid.locked')
  assert not errors,errors
  print('PASS: compact card settings and focus, two registry sections, live-form staging, single-sheet three-tab preview, confirm-only publish, cancellation, stale preview, chunk continuation, stable retry, Grid bridge, revocation and mobile/XSS safety; RPC concurrency1')
  browser.close()
if __name__=='__main__':main()
