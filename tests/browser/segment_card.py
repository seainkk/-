"""Segment card from the production navigation, using synthetic Sheets and Coldy responses."""
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import expect, sync_playwright
from performance_client import FIXTURE, HTML, ROOT

DATA = """
const cardRows=[
  {value:'both@example.test',channel:'email',owners:['companies','lpr'],ownerNames:['Компания','Представитель'],manualStatuses:['фильтр'],readiness:'Исключён вручную',validationStatuses:['Валиден'],ready:false,inCampaign:true,coldyStatuses:['Отправлено писем: 2'],channelFacts:[{campaign:'Тестовая кампания',statuses:['Отправлено писем: 2']}],campaigns:['Тестовая кампания'],sources:[{name:'Рабочая таблица',url:'https://docs.google.com/spreadsheets/d/synthetic/edit#gid=2&range=A3',column:'Рабочая почта'}]},
  {value:'+79990000001',channel:'telegram',owners:['companies'],ownerNames:['=SUM(1)'],manualStatuses:['Новый контакт'],readiness:'Готов',validationStatuses:['Проверен'],ready:true,inCampaign:false,coldyStatuses:[],campaigns:[]},
  {value:'review@example.test',channel:'email',owners:['companies'],ownerNames:['Компания'],manualStatuses:['Новый контакт'],readiness:'Выбрать «Готов» или «Фильтр»',needsStatus:true,validationStatuses:['Валиден'],ready:false,inCampaign:false,coldyStatuses:[],campaigns:[]},
  {value:'@manualname',channel:'telegram',owners:['companies'],ownerNames:[],manualStatuses:['Ручная проверка'],readiness:'Ручная проверка',telegramReview:true,validationStatuses:[],ready:false,inCampaign:false,coldyStatuses:[],campaigns:[]},
  {value:'+79990000002',channel:'telegram',owners:['companies'],ownerNames:[],manualStatuses:['Записная книжка'],readiness:'Записная книжка',addressBook:true,validationStatuses:['Валиден'],ready:false,inCampaign:false,coldyStatuses:[],campaigns:[]}
];
api.getSegmentContactCard=p=>{
  const filtered=cardRows.filter(r=>(p.channel==='all'||p.channel===r.channel)&&(p.owner==='all'||r.owners.includes(p.owner))&&(p.queue==='all'||(p.queue==='ready'&&r.ready)||(p.queue==='inCampaign'&&r.inCampaign)||(p.queue==='emailReview'&&r.needsStatus)||(p.queue==='telegramReview'&&r.telegramReview)||(p.queue==='telegramBook'&&r.addressBook))&&(!p.query||r.value.includes(p.query)));
  const rows=filtered.slice(p.offset,p.offset+p.limit).map(row=>({...row,...(p.prepared?{sources:[]}: {})}));
  return {segmentId:p.segmentId,name:'Пилот',revision:'v1',prepared:!!p.prepared,checkedAt:'2026-11-26T00:00:00Z',summary:{email:{total:2,ready:0,toCheck:0,toReview:1},telegram:{total:3,ready:1,toCheck:0,toReview:1,addressBook:1},sharedEmail:1,ownership:0},files:{companies:{id:p.segmentId+'-companies',name:'Компании'}},warnings:[],total:filtered.length,offset:p.offset,nextOffset:p.offset+rows.length<filtered.length?p.offset+rows.length:null,rows};
};
const segmentDashboard=api.getSegmentsDashboard;
api.getSegmentsDashboard=p=>{
  const result=segmentDashboard(p);
  if(p?.includeCardPreview&&!backend.omitPreviews){
    const id='existing-segment';
    result.cardPreviews={[id]:{...api.getSegmentContactCard({segmentId:id,channel:'all',owner:'all',queue:'all',prepared:true,offset:0,limit:1}),preview:true}};
  }
  return result;
};
api.getSegmentLegacyPreview=p=>({segmentId:p.segmentId,sources:[{id:'legacy',name:'Старый оригинал'}],history:[{name:'Импорт контактов',kind:'Завершён'}],preview:p.sourceId?{source:{id:'legacy',name:'Старый оригинал'},complete:true,channels:{email:{added:12,existing:1,duplicates:2}},entities:{companies:13},warnings:[]}:null});
api.refreshColdyMailings=p=>({campaigns:[{id:'test',name:'Тестовая кампания'}]});
api.getSegmentSelections=()=>({filters:[],exports:[],campaigns:[{id:'test',name:'Тестовая кампания'}]});
api.saveSegmentFilter=p=>({id:'filter-id',name:p.name,...p.filter});
api.saveSegmentExport=p=>{if(!backend.snapshotRetry){backend.snapshotRetry=p.requestId;throw new Error('Не удалось подтвердить запись');}
  if(p.requestId!==backend.snapshotRetry)throw new Error('Требуется тот же запрос');
  return {id:'snapshot-id',campaignName:'Тестовая кампания',name:p.name,count:p.rows.length};};
"""


def check_directory_preview(browser):
    page=browser.new_page()
    page.set_content(''.join((ROOT/'src'/(part+'.html')).read_text(encoding='utf8')
                              for part in ['SegmentCardPanel','SegmentCardClient','SegmentSelectionsClient']))
    page.evaluate("""()=>{window.backend={};window.api={getSegmentsDashboard:()=>({state:'ready',
      items:[{id:'existing-segment',files:[{id:'existing-segment-companies'}]}]})};"""+DATA+"}")
    page.evaluate("""()=>{
      window.authorized=false;window.reads=[];window.statusIds=[];
      window.RegistrySegmentWorkStatus={mount:(container,id)=>{
        if(!authorized)throw Error('status before authorization');
        statusIds.push(id);container.textContent='В работе';
      }};
      RegistrySegmentCard.configure({active:()=>authorized,error:e=>e,rpc:(method,p,valid)=>{
        reads.push(p);
        if(!authorized||!valid())throw Error('premature read');
        return Promise.resolve(api[method](p));
      }});
      RegistrySegmentCard.acceptDashboard(api.getSegmentsDashboard({includeCardPreview:true}));
      RegistrySegmentCard.preview('existing-segment','Кухни','Намшилд / Клиенты');
      RegistrySegmentCard.show(true);
    }""")
    expect(page.locator('#sc-title')).to_have_text('Кухни')
    expect(page.locator('#sc-summary')).to_have_count(0)
    expect(page.locator('#sc-secondary > summary')).to_have_accessible_name('Действия сегмента')
    expect(page.locator('#sc-work-status')).to_be_empty()
    expect(page.locator('#sc-table-wrap thead')).to_be_visible()
    expect(page.locator('#sc-add')).to_be_disabled()
    expect(page.locator('#sc-coldy')).to_be_disabled()
    page.locator('[data-sc-channel="telegram"]').click()
    page.locator('#sc-owner').select_option('companies')
    page.locator('[data-sc-state="ready"]').click()
    query=page.locator('#sc-query')
    query.fill('79990')
    page.evaluate('RegistrySegmentCard.refresh({automatic:true})')
    page.evaluate('RegistrySegmentCard.acceptDashboard(api.getSegmentsDashboard({includeCardPreview:true}))')
    expect(page.locator('#sc-rows')).to_be_empty()
    assert page.evaluate('reads.length')==0
    page.evaluate("""async ()=>{
      authorized=true;
      const first=Promise.resolve({page:api.getSegmentContactCard(RegistrySegmentCard.firstPageRequest('existing-segment'))});
      RegistrySegmentCard.select('existing-segment','Кухни','Намшилд / Клиенты',first);
      await RegistrySegmentCard.refresh({opening:true});
    }""")
    expect(query).to_have_value('79990')
    expect(query).to_be_focused()
    expect(page.locator('#sc-add')).to_be_enabled()
    assert page.evaluate('statusIds')==['existing-segment']
    expect(page.locator('#sc-rows tr')).to_have_count(1)
    expect(page.locator('#sc-rows tr')).to_contain_text('+79990000001')
    assert page.evaluate("reads.length===1&&reads[0].query==='79990'&&reads[0].channel==='telegram'&&reads[0].owner==='companies'")
    page.evaluate("authorized=false;RegistrySegmentCard.preview('existing-segment','Кухни','Намшилд');RegistrySegmentCard.show(true)")
    expect(page.locator('#sc-rows')).to_be_empty()
    page.evaluate("RegistrySegmentCard.clear()")
    expect(page.locator('#sc-view')).to_be_hidden()
    page.close()


def main():
    html=HTML.replace(FIXTURE,FIXTURE+DATA,1)
    for part in ('SegmentCardPanel','SegmentCardClient','SegmentSelectionsClient'):
        html=html.replace("<?!= include_('"+part+"'); ?>",(ROOT/'src'/(part+'.html')).read_text(encoding='utf-8'))
    with sync_playwright() as pw:
        launch={'channel':'chrome'} if sys.platform=='win32' else {'executable_path':'/usr/bin/chromium'}
        browser=pw.chromium.launch(**launch, headless=True)
        check_directory_preview(browser)
        page=browser.new_page()
        errors=[]
        page.on('pageerror',lambda error: errors.append(str(error)))
        page.set_content(html)
        page.locator('#br-view-segments').click()
        segment=page.locator('[data-segment="existing-segment"]')
        page.evaluate("backend.holdMethods=['getSegmentContactCard']")
        opening=segment.locator('.br-segment-row-name').evaluate("""button=>{
          const start=performance.now();
          button.click();
          return new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done({
            ms:performance.now()-start,first:document.querySelector('#sc-rows tr td')?.textContent
          }))));
        }""")
        assert opening['first'] and 'both@example.test' in opening['first'] and opening['ms']<2000,opening
        print('Authorized dashboard preview, click to painted row: %.0f ms'%opening['ms'],flush=True)
        rows=page.locator('#sc-rows tr')
        expect(rows).to_have_count(1)
        expect(page.locator('#sc-next')).to_be_enabled()
        expect(page.locator('#sc-status')).to_contain_text('Карточка собрана')
        page.wait_for_function("backend.pending.some(r=>r.method==='getSegmentContactCard'&&r.payload.prepared)")
        page.evaluate("backend.holdMethods=[];releaseRpc('getSegmentContactCard')")
        expect(rows).to_have_count(5)
        assert page.evaluate("backend.calls.filter(c=>/Coldy|LegacyPreview|Promouser/.test(c.name)).length")==0
        expect(rows.first.locator('td').nth(2)).to_have_text('фильтр')
        expect(rows.first.locator('td').nth(4)).to_contain_text('Отправлено писем: 2')
        rows.first.locator('summary').click()
        expect(rows.first.locator('a')).to_have_attribute('href','https://docs.google.com/spreadsheets/d/synthetic/edit#gid=2&range=A3')
        rows.first.locator('summary').focus()
        page.evaluate('window.sourceAction=document.activeElement')
        page.evaluate('RegistrySegmentCard.refresh({automatic:true})')
        assert page.evaluate('sourceAction===document.activeElement && sourceAction.closest("details").open')
        expect(rows.first.locator('a')).to_be_visible()
        assert page.evaluate("backend.calls.some(c=>c.name==='getSegmentContactCard'&&c.p.limit===1&&c.p.revision==='v1'&&!c.p.prepared)")
        page.locator('[data-sc-state="inCampaign"]').click()
        expect(rows).to_have_count(1)
        expect(rows.first).to_contain_text('both@example.test')
        page.locator('[data-sc-state="ready"]').click()
        menu=page.locator('#sc-secondary > summary')
        expect(page.locator('#sc-export')).to_be_hidden()
        menu.click()
        page.keyboard.press('Escape')
        expect(page.locator('#sc-export')).to_be_hidden()
        menu.press('Enter')
        expect(rows.first).to_contain_text('+79990000001')
        with TemporaryDirectory() as temp:
            with page.expect_download() as download:
                page.locator('#sc-export').click()
            path=Path(temp)/'contacts.csv'
            download.value.save_as(path)
            csv=path.read_text(encoding='utf-8-sig')
            assert csv.count('"+79990000001"')==1 and 'both@example.test' not in csv and "'=SUM(1)" in csv
        assert page.evaluate("backend.calls.filter(c=>c.name==='saveSegmentExport').length")==0
        assert page.evaluate("backend.calls.some(c=>c.name==='getSegmentContactCard'&&c.p.limit===200&&!c.p.prepared&&c.p.revision==='v1')")
        saved=page.locator('#sc-saved-actions')
        saved.locator('summary').click()
        saved.locator('[name="filterName"]').fill('Готовые Telegram')
        saved.get_by_role('button',name='Сохранить фильтр').click()
        expect(saved.get_by_role('button',name='Готовые Telegram')).to_be_visible()
        saved.locator('#sc-export-campaign').select_option('test')
        page.locator('#sc-export').click()
        expect(page.locator('#sc-export-status')).to_contain_text('Не удалось подтвердить запись')
        with page.expect_download():
            page.locator('#sc-export').click()
        assert page.evaluate("backend.calls.filter(c=>c.name==='saveSegmentExport').every(c=>c.p.rows.length===1&&c.p.rows[0].value==='+79990000001'&&c.p.campaignId==='test')")
        saved.get_by_role('button',name='Свернуть').click()
        page.locator('#sc-prepare').click()
        expect(page.locator('#sc-prep-panel')).to_be_visible()
        page.locator('[data-sc-queue="emailReview"]').click()
        expect(rows).to_have_count(1)
        expect(rows.first).to_contain_text('review@example.test')
        page.locator('[data-sc-queue="telegramReview"]').click()
        expect(rows.first).to_contain_text('@manualname')
        page.locator('[data-sc-queue="telegramBook"]').click()
        expect(rows.first).to_contain_text('+79990000002')
        page.locator('#sc-prep-panel [data-sc-dismiss]').click()
        menu.click()
        page.locator('#sc-origins').click()
        expect(page.locator('#sc-history')).to_contain_text('Завершён')
        page.locator('#sc-sources button').click()
        expect(page.locator('#sc-preview')).to_contain_text('новых 12')
        expect(page.locator('#sc-legacy-note')).to_contain_text('не перенесены')
        page.locator('#sc-origins-panel [data-sc-dismiss]').click()
        menu.click()
        page.locator('#sc-coldy').click()
        expect(page.locator('#sc-campaigns')).to_contain_text('Тестовая кампания')
        assert page.evaluate("backend.calls.filter(c=>/^(start|upload|enable|sync)/.test(c.name)).length")==0
        page.locator('#sc-coldy-panel [data-sc-dismiss]').click()
        menu.click()
        page.locator('#sc-add').click()
        expect(page.locator('#br-import-destination')).to_have_value('existing-segment')
        page.locator('#br-import-cancel').click()
        expect(page.locator('#sc-view')).to_be_visible()
        page.evaluate("backend.holdMethods=['getSegmentContactCard']")
        page.locator('[data-sc-channel="telegram"]').click()
        page.wait_for_function("backend.pending.some(p=>p.method==='getSegmentContactCard')")
        page.evaluate("backend.omitPreviews=true")
        page.locator('#br-project').select_option('neosender')
        page.evaluate("releaseRpc('getSegmentContactCard')")
        expect(page.locator('#sc-view')).to_be_hidden()
        expect(page.locator('#sc-rows')).to_be_empty()
        page.locator('#br-view-segments').click()
        segment.locator('.br-segment-row-name').click()
        page.wait_for_function("backend.pending.some(r=>r.method==='getSegmentContactCard')")
        expect(rows).to_have_count(0)
        expect(page.locator('#sc-table-wrap thead')).to_be_visible()
        expect(page.locator('#sc-summary')).to_have_count(0)
        menu.click()
        expect(page.locator('#sc-saved-actions summary')).to_be_visible()
        assert page.locator('#sc-saved-actions details').evaluate('node=>node.inert')
        page.evaluate("""() => {
          backend.omitPreviews=false;
          const response=api.getSegmentsDashboard({includeAnalysis:false,includeCardPreview:true});
          window.RegistrySegmentCard.acceptDashboard(response);
        }""")
        expect(rows).to_have_count(1)
        expect(rows.first).to_contain_text('both@example.test')
        expect(page.locator('#sc-status')).to_contain_text('Карточка собрана')
        assert not page.locator('#sc-saved-actions details').evaluate('node=>node.inert')
        page.evaluate("backend.holdMethods=[];releaseRpc('getSegmentContactCard')")
        expect(rows).to_have_count(5)
        assert not errors,errors
        browser.close()


if __name__ == '__main__':
    main()
