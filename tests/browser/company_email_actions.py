"""Company Email workbook actions through the public grid, with simulated RPCs only."""
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from project_client import integrated_html


FIXTURE = """
gridBackend.contactsEnabled=true;
gridServerEdit(1,1,5,'Статус');gridServerEdit(1,2,5,'Новый контакт');
gridBackend.sheets[2].name='Телеграм';gridServerEdit(2,1,4,'Статус');gridServerEdit(2,2,4,'Новый контакт');
const readyCampaign='11111111-1111-4111-8111-111111111112';
const readySegment='segment-email-test';
const readyCalls=window.readyCalls=[];
const observed=(method,action)=>async payload=>{readyCalls.push({method,p:structuredClone(payload)});return action(payload);};
for(const method of ['getGridWorkbook','getGridRange','getContactWorkspace','getValidationState','getColdyValidationState']){
  api[method]=observed(method,async p=>{
    const value=await fakeGridRpc(method,p);
    if(method==='getGridWorkbook'&&p.id==='source-companies'){
      value.companyEmailSegment=readySegment;value.companyEmailSheetId=1;
      value.companyTelegramSheetId=2;value.companyTelegramStatuses=['Новый контакт','Готов','Записная книжка','Не активен > 30 дней','Ручная проверка','Невалид'];
      value.companyEmailStatuses=['Новый контакт','Готов','Рассылка','Фильтр','Невалид'];
    }
    if(method==='getContactWorkspace'&&p.id==='source-companies'){
      value.role='segment-companies';value.segmentId=readySegment;
    }
    return value;
  });
}
api.listColdyCampaigns=observed('listColdyCampaigns',()=>({state:'ready',campaigns:[{id:readyCampaign,name:'Тестовая активная',status:'Active'}]}));
api.previewColdyWorkbookUpload=observed('previewColdyWorkbookUpload',p=>({
  previewToken:'token-of-a-ready-workbook',segmentId:readySegment,canUpload:true,
  campaign:p.mode==='new'?{name:p.name,status:'Draft'}:{id:readyCampaign,name:'Тестовая активная',status:'Active'},
  counts:{total:4,eligible:2,notReady:1,excluded:1},sample:[{email:'ready@example.test'}],warnings:[]
}));
const makeJob=(p,state)=>({state,segmentId:readySegment,bindingId:'workbook-binding-for-test',jobId:'workbook-job-for-tests',
  requestId:p.requestId,counts:{created:state==='complete'?2:0},progress:{completed:state==='complete'?2:0,total:2,label:state==='complete'?'Загрузка завершена':'Загружаем'},warnings:[]});
window.interruptNextStart=false;
api.startColdyWorkbookUpload=observed('startColdyWorkbookUpload',p=>{
  if(window.interruptNextStart){window.interruptNextStart=false;throw new Error('Связь прервана');}
  return makeJob(p,'processing');
});
api.continueColdyUpload=observed('continueColdyUpload',p=>makeJob(p,'complete'));
api.previewPromouserValidation=observed('previewPromouserValidation',()=>({kind:'email',canStart:true,plannedCount:2,
  previewToken:'synthetic-promo-preview',fingerprint:'synthetic-promo-fingerprint',counts:{new:2},autoPayLimitUsd:5}));
api.startPromouserValidation=observed('startPromouserValidation',()=>({state:'complete',configured:true,enabled:true,counts:{checked:2},jobs:[]}));
api.exportCompanyTelegramCsv=observed('exportCompanyTelegramCsv',p=>({state:'ready',count:1,withoutPhone:p.mode==='ready'?1:0,message:'Строк в CSV: 1',filename:'numshield-'+p.mode+'.csv',csv:'\uFEFF"Username","Телефон"'}));
"""


def main():
    grid = Path(__file__).with_name('grid-fixture.js').read_text(encoding='utf-8')
    html = integrated_html().replace('api.getColdySettings=', grid + FIXTURE + 'api.getColdySettings=', 1)
    with sync_playwright() as runtime:
        launch = {'channel': 'chrome'} if sys.platform == 'win32' else {'executable_path': '/usr/bin/chromium'}
        browser = runtime.chromium.launch(**launch, headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1440, 'height': 980})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(html)
        page.locator('[data-source-id="source-companies"] h2 button').click()
        page.locator('#rg-grid-tabs [data-sheet-id="1"]').click()
        page.locator('#rg-cell-2-5').click()
        status = page.locator('#rg-grid-workflow-status')
        expect(status).to_be_visible()
        assert status.locator('option').all_text_contents()==['Новый контакт','Готов','Рассылка','Фильтр','Невалид']
        button = page.locator('#rg-grid-mail-open')
        panel = page.locator('#rg-grid-mail-panel')
        start = page.locator('#rg-grid-mail-start')
        button.click()
        expect(panel).to_be_visible()
        page.locator('#rg-grid-mail-mode').select_option('new')
        page.locator('#rg-grid-mail-name').fill('Новая тестовая')
        page.locator('#rg-grid-mail-preview').click()
        expect(start).to_be_enabled()
        page.locator('#rg-grid-mail-close').click()
        expect(panel).to_be_hidden()
        assert not page.evaluate("readyCalls.some(c=>c.method.startsWith('start'))")

        button.click()
        page.locator('#rg-grid-mail-mode').select_option('existing')
        page.locator('#rg-grid-mail-campaign').select_option('11111111-1111-4111-8111-111111111112')
        page.locator('#rg-grid-mail-preview').click()
        active = page.locator('#rg-grid-mail-active')
        expect(active).to_be_visible()
        expect(start).to_be_disabled()
        active.check()
        start.click()
        page.wait_for_function("readyCalls.some(c=>c.method==='continueColdyUpload')")
        payloads = page.evaluate("readyCalls.filter(c=>c.method==='startColdyWorkbookUpload'||c.method==='continueColdyUpload').map(c=>c.p)")
        assert payloads[0]['id']=='source-companies' and payloads[0]['allowActive'] is True
        assert payloads[0]['requestId']==payloads[1]['requestId']
        expect(page.locator('#rg-grid-mail-status')).to_contain_text('заверш',ignore_case=True)
        page.locator('#rg-grid-mail-close').click()

        button.click()
        page.locator('#rg-grid-mail-mode').select_option('new')
        page.locator('#rg-grid-mail-name').fill('Черновик для проверки повтора')
        page.locator('#rg-grid-mail-preview').click()
        page.evaluate('interruptNextStart=true')
        start.click()
        expect(page.locator('#rg-grid-mail-status')).to_contain_text('Связь прервана')
        page.locator('#rg-grid-mail-close').click()
        button.click()
        expect(page.locator('#rg-grid-mail-mode')).to_have_value('new')
        expect(start).to_have_text('Продолжить тот же запрос')
        start.click()
        expect(page.locator('#rg-grid-mail-status')).to_contain_text('заверш',ignore_case=True)
        attempts = page.evaluate("readyCalls.filter(c=>c.method==='startColdyWorkbookUpload').slice(-2).map(c=>c.p)")
        assert attempts[0] == attempts[1] and attempts[0]['allowActive'] is False
        assert set(attempts[0]) == {'id','previewToken','requestId','allowActive'}
        page.locator('#rg-grid-mail-close').click()

        page.locator('#rg-grid-email-check').click()
        expect(page.locator('#rg-grid-bulk-start')).to_be_enabled()
        pv = page.evaluate("readyCalls.filter(c=>c.method==='previewPromouserValidation').at(-1)?.p")
        assert pv and pv['id']=='source-companies' and pv['kind']=='email' and pv['newContactsOnly']
        page.locator('#rg-grid-validation-close').click()
        assert not page.evaluate("readyCalls.some(c=>c.method==='startPromouserValidation')")

        page.locator('#rg-grid-tabs [data-sheet-id="2"]').click()
        page.locator('#rg-cell-2-4').click()
        assert 'Записная книжка' in status.locator('option').all_text_contents()
        expect(button).to_be_hidden()
        page.locator('#rg-grid-telegram-check').click()
        expect(page.locator('#rg-grid-validation-title')).to_have_text('Проверка новых телефонов')
        expect(page.locator('#rg-grid-bulk-start')).to_be_enabled()
        assert page.evaluate("readyCalls.filter(c=>c.method==='previewPromouserValidation').at(-1).p.kind")=='telegram'
        page.locator('#rg-grid-bulk-start').click()
        page.wait_for_function("readyCalls.some(c=>c.method==='startPromouserValidation' && c.p.kind==='telegram')")
        page.locator('#rg-grid-validation-close').click()
        for control, mode in [('ready','ready'),('book','addressBook')]:
            page.locator('#rg-grid-telegram-'+control).click()
            link = page.locator('#rg-grid-telegram-download')
            expect(link).to_be_visible()
            with page.expect_download() as info:
                link.click()
            assert info.value.suggested_filename=='numshield-'+mode+'.csv'
            assert info.value.path().read_bytes().startswith(bytes.fromhex('efbbbf'))
            assert page.evaluate("readyCalls.filter(c=>c.method==='exportCompanyTelegramCsv').at(-1).p")=={'id':'source-companies','sheetId':2,'mode':mode}
            page.locator('#rg-grid-back').click()
            expect(link).to_be_hidden()

        page.locator('#rg-grid-close').click()
        page.locator('[data-source-id="source-mixed"] h2 button').click()
        page.locator('#rg-grid-tabs [data-sheet-id="1"]').click()
        expect(button).to_be_hidden()
        expect(page.locator('#rg-grid-email-check')).to_be_hidden()
        expect(panel).to_be_hidden()
        assert not errors, errors
        browser.close()
        print('PASS: company Email and Telegram actions, validation scope, confirmed mailing retries and both CSV downloads.')


if __name__ == '__main__':
    main()
