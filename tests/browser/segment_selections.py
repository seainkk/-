"""Saved filters, fixed recipient snapshots, retry and segment isolation with synthetic RPCs."""
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = (ROOT / 'src' / 'SegmentSelectionsClient.html').read_text(encoding='utf-8')
FIXTURE = """
<div id="sc-saved-actions"></div>
<script>
const base={name:'Кухни',segmentId:'segment1',revision:'v1',channel:'email',owner:'all',queue:'ready',query:'исходный'};
let filters={...base},rows=[{channel:'email',value:'first@example.org'},{channel:'telegram',value:'+79990001122'}];
const history=[],savedFilters=[],snapshots=new Map(),receipts=new Map(),calls=[];
let lost=false,hold=false,resume=null;
window.RegistrySegmentCard={getFilters:()=>filters,setFilters:f=>{Object.assign(filters,f);window.dispatchEvent(new Event('segment-card-update'));}};
const rpc=async(method,payload,valid)=>{
  if(!valid())return null;
  calls.push({method,payload:structuredClone(payload)});
  if(hold&&method==='getSegmentSelections'){
    hold=false;
    const old={exports:[{id:'foreign',name:'Скрытая выгрузка чужого проекта',count:2}],filters:[]};
    await new Promise(resolve=>{resume=resolve;});
    return old;
  }
  if(method==='getSegmentSelections')return {exports:structuredClone(history),filters:structuredClone(savedFilters),campaigns:[{name:'Кухни ЛПР',id:'camp1'}]};
  if(receipts.has(payload.requestId))return receipts.get(payload.requestId);
  if(method==='saveSegmentFilter'){
    const item={...payload,id:'f1'};savedFilters.push(item);receipts.set(payload.requestId,item);return item;
  }
  if(method==='saveSegmentExport'){
    const item={id:'e1',count:payload.rows.length,name:payload.name,createdAt:'2026-11-26T08:10:00Z',campaignName:payload.campaignId?'Кухни ЛПР':''};
    snapshots.set(item.id,structuredClone(payload.rows));history.push(item);receipts.set(payload.requestId,item);
    if(lost){lost=false;throw new Error('Ответ о сохранении потерян');}
    return item;
  }
  if(method==='getSegmentExport'){
    const saved=snapshots.get(payload.id),offset=payload.offset;
    return {...history.find(item=>item.id===payload.id),rows:saved.slice(offset,offset+1),nextOffset:offset+1<saved.length?offset+1:null};
  }
  throw new Error(method);
};
const exportRows=()=>window.RegistrySegmentSelections.recordExport({...filters},rows);
const update=()=>window.dispatchEvent(new Event('segment-card-update'));
const clear=()=>window.dispatchEvent(new Event('segment-card-clear'));
</script>
"""


def main():
    with sync_playwright() as pw:
        launch = {'channel': 'chrome'} if sys.platform == 'win32' else {'executable_path': '/usr/bin/chromium'}
        browser = pw.chromium.launch(**launch, headless=True, args=['--no-sandbox'])
        page = browser.new_page(accept_downloads=True)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(FIXTURE + SCRIPT)
        page.evaluate("RegistrySegmentSelections.configure({rpc,error:error=>({message:error.message})});update();")
        details = page.locator('#sc-saved-actions details')
        summary = details.locator('summary')
        expect(summary).to_be_visible()
        assert page.evaluate('calls.length') == 0
        assert page.evaluate('exportRows()') is None
        assert page.evaluate('calls.length') == 0

        summary.click()
        expect(page.get_by_text('Сохранённых фильтров пока нет.')).to_be_visible()
        page.get_by_label('Название текущего фильтра').fill('Готовые компании')
        page.get_by_role('button', name='Сохранить фильтр').click()
        apply = page.get_by_role('button', name='Готовые компании')
        expect(apply).to_be_visible()
        page.evaluate("filters.query='позднее';update()")
        apply.click()
        assert page.evaluate('filters.query') == 'исходный'
        expect(details).not_to_have_attribute('open', '')

        summary.click()
        page.get_by_label('Рассылка для выгрузки').select_option('camp1')
        page.evaluate('lost=true')
        assert page.evaluate("exportRows().then(()=>'',e=>e.message)") == 'Ответ о сохранении потерян'
        saved = page.evaluate('exportRows()')
        assert saved['name'] == 'Кухни ЛПР' and saved['count'] == 2
        assert page.evaluate("new Set(calls.filter(x=>x.method==='saveSegmentExport').map(x=>x.payload.requestId)).size") == 1
        assert page.evaluate('history.length') == 1
        page.evaluate("rows=[{channel:'email',value:'later@example.org'}];filters.revision='v2';update()")
        with page.expect_download() as promise:
            page.get_by_role('button', name='Скачать адресатов').click()
        downloaded = promise.value
        text = Path(downloaded.path()).read_text(encoding='utf-8-sig')
        assert downloaded.suggested_filename == 'Кухни ЛПР.csv'
        assert 'first@example.org' in text and 'later@example.org' not in text
        assert '"+79990001122"' in text
        assert page.evaluate("calls.filter(x=>x.method==='getSegmentExport').map(x=>x.payload.offset)") == [0, 1]

        page.evaluate("hold=true")
        page.get_by_role('button', name='Обновить список').click()
        page.wait_for_function("!!resume")
        page.evaluate("clear();filters={...base,segmentId:'segment2',name:'Другой проект'};update();resume();")
        expect(page.get_by_text('Скрытая выгрузка чужого проекта')).to_have_count(0)
        expect(page.get_by_text('Готовые компании')).to_have_count(0)
        assert page.evaluate('document.querySelectorAll("#sc-export-campaign").length') == 1
        assert not errors, errors
        browser.close()
        print('PASS: lazy filters, no-op CSV, retry with one request ID, immutable download, stale project guard.')


if __name__ == '__main__':
    main()
