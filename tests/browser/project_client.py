"""Analytics/infrastructure UI with held requests and local API fakes only."""
from pathlib import Path
import json
import sys
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = r"""
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333',D='44444444-4444-4444-8444-444444444444';
window.backend={configured:true,connected:true,calls:[],active:0,activeWrites:0,maxWrites:0,pending:[],holdMethods:[],receipts:{},failAfterSave:false,saveMutations:0,connectionOpens:0,infraSynced:false,infraContinued:false,failInfra:false,accountMarker:'sender',monitoringIds:[],monitoringRevision:0,monitoringConfigured:false,monitoringScope:'project-key-scope',monitoringReceipts:{},inventoryLoaded:true,detailIds:[],lastSyncAt:'2026-11-22T09:00:00Z'};
backend.bindings=[{id:'binding-existing-00000001',segmentId:'segment-a',campaignId:A,campaignName:'Existing campaign',includeCompanies:false,includeLpr:true,autoUpload:true,allowActive:true,revision:4},{id:'binding-other-0000000002',segmentId:'segment-b',campaignId:C,campaignName:'Other campaign',includeCompanies:true,includeLpr:false,autoUpload:false,allowActive:false,revision:1},{id:'binding-missing-00000003',segmentId:'segment-a',campaignId:D,campaignName:'Removed at provider',includeCompanies:true,includeLpr:true,autoUpload:false,allowActive:false,revision:1}];
const clone=x=>JSON.parse(JSON.stringify(x));
function campaigns(id){const rows=[{id:A,name:'Existing campaign',status:'Active'},{id:B,name:'New campaign',status:'Draft'},{id:C,name:'Other campaign',status:'Paused'},...(backend.extraCampaigns||[])];for(const binding of backend.bindings.filter(x=>x.segmentId===id&&x.campaignId===D))rows.push({id:D,name:binding.campaignName,status:'Unknown',missing:true});return rows.map(item=>{const owner=backend.bindings.find(x=>x.campaignId===item.id),own=owner?.segmentId===id;return {...item,selected:own,bindingId:own?owner.id:null,ownerSegmentId:owner?.segmentId||null,ownerSegmentName:owner?.segmentId==='segment-b'?'Segment B':null,selectable:!item.missing&&(!owner||own),available:!item.missing,removable:own,blockedReason:item.missing?'Рассылка удалена в Coldy':owner&&!own?'Уже связана с другим сегментом':''};});}
function service(id){return {id:'coldy',state:'partial',totals:{sent:100,replies:5,leads:null},campaigns:backend.bindings.filter(x=>x.segmentId===id).map(x=>({id:x.campaignId,name:x.campaignName,status:'Active',sent:x.campaignId===A?100:null,replies:5,leads:null})),generatedAt:'2026-11-22T09:00:00Z'};}
function monitoring(){return {configured:backend.monitoringConfigured,revision:backend.monitoringRevision,accountIds:[...backend.monitoringIds],scopeToken:backend.monitoringScope};}
function inventory(){return backend.inventoryLoaded?Array.from({length:backend.largeInventory||6},(_,i)=>({id:'account-'+i,email:(backend.largeInventory?'large-sender-':backend.accountMarker)+i+'@example.test',name:(backend.senderName||'Sender ')+i,provider:'SMTP'})):[];}
function selectionDto(query){if(query)backend.inventoryLoaded=true;
 const q=String(query||'').toLowerCase(),accounts=inventory().filter(a=>backend.monitoringIds.includes(a.id)||q&&[a.email,a.name,a.id].some(v=>v.toLowerCase().includes(q))).slice(0,50);
 return {configured:backend.configured,selection:monitoring(),accounts,availableCount:accounts.length,inventoryAt:backend.inventoryLoaded?backend.lastSyncAt:null};}
function poolData(accounts){
 if(!backend.infraSynced||!backend.configured)return {state:'unknown',updatedAt:null,campaigns:[],stale:true};
 const schedule={days:['monday','tuesday','wednesday','thursday','friday'],from:'09:00',to:'18:30',timezone:'Europe/Moscow',gapStartSeconds:60,gapEndSeconds:90};
 const campaignList=[{id:A,name:'Намшилд / Кухни',status:'Active',segmentName:'Кухни',segmentProjectName:'Проект 2',bindingState:'linked',schedule,waitSchedule:true,endAt:null},
  {id:B,name:'Веб-студии',status:'Active',bindingState:'unlinked',schedule:null,endAt:null},
  {id:C,name:'Только в другом пуле',status:'Active',bindingState:'linked',schedule:null,endAt:null}];
 for(const item of accounts){
  const busy=item.id==='account-0',unknown=item.id==='account-2'||backend.uncertainCapacity;
  item.capacity={state:unknown?'unknown':busy?'busy':'free',campaignIds:busy?[A,B]:[],availableAt:null,
   idleFrom:busy&&!unknown?'2026-11-23T15:30:00.000Z':null,idleUntil:busy&&!unknown?'2026-11-24T06:00:00.000Z':null};
 }
 return {state:backend.uncertainCapacity?'partial':'ready',stale:!!backend.uncertainCapacity,updatedAt:backend.lastSyncAt,campaigns:campaignList};
}
function infra(){
 const total=backend.monitoringIds.length,completed=backend.detailIds.length,poolOnly=backend.syncMode==='pool';
 const nextCursor=poolOnly&&backend.poolPending?'pool-schedule-cursor':backend.syncMode==='diagnostics'&&completed<total?'details-'+completed:null;
 const accounts=inventory().filter(item=>backend.monitoringIds.includes(item.id)).map((item,i)=>({...item,status:i<completed?(item.id==='account-1'?'error':'connected'):null,sentTotal:i<completed&&item.id==='account-0'?100:null,sentToday:null,dailyLimit:i<completed?40:null,errorCount:null,errors:i<completed&&item.id==='account-1'?[{code:'SMTP',message:'<img src=x onerror=alert(1)> disconnected'}]:[],tags:[],warmup:{status:null,sentToday:null,repliesToday:null},updatedAt:i<completed?backend.lastSyncAt:null,stale:i>=completed}));
 return {state:!backend.configured?'not_configured':!total?'no_selection':!backend.infraSynced?'not_synced':completed<total?'partial':'ready',configured:backend.configured,connected:backend.connected,accounts,capacity:poolData(accounts),monitoring:{...monitoring(),selectedCount:total,missingAccountIds:[]},availableCount:backend.inventoryLoaded?(backend.largeInventory||6):null,totals:{accounts:backend.configured?total:null,sentTotal:accounts.length&&accounts.every(item=>item.sentTotal!==null)?accounts.reduce((sum,item)=>sum+item.sentTotal,0):null,sentToday:null,dailyLimit:null,errorCount:null,accountsWithErrors:accounts.filter(item=>item.errors.length).length},lastSyncAt:backend.infraSynced?backend.lastSyncAt:null,warnings:[],nextCursor,poolOnly,syncProgress:poolOnly?{completed:backend.poolPending?1:2,total:2}:{completed,total},detailProgress:{completed:poolOnly?0:completed,total},syncPaused:false,retryAfterMs:0,error:null,countersScope:'selected_accounts',stale:!total};
}
function api(name,p){
 if(name==='getProjectAnalytics')return {state:backend.catalogState||'ready',segments:backend.catalogState?[]:[{id:'segment-a',name:'Segment A'},{id:'segment-b',name:'Segment B'}],coldy:{configured:backend.configured,connected:backend.connected,checkedAt:null}};
 if(name==='getProjectAnalyticsCampaigns'){
  const terms=String(p.query||'').toLowerCase().split(/\s+/).filter(Boolean);
  let found=0;
  const result=campaigns(p.segmentId).filter(row=>row.selected||terms.length&&terms.every(term=>row.name.toLowerCase().includes(term))&&++found<=40);
  return {state:backend.configured?'ready':'not_configured',configured:backend.configured,connected:backend.connected,segment:{id:p.segmentId,name:p.segmentId==='segment-a'?'Segment A':'Segment B'},bindings:clone(backend.bindings.filter(x=>x.segmentId===p.segmentId)),campaigns:backend.configured?result:[],truncated:found>40,matchCount:found,generatedAt:'2026-11-22T09:00:00Z',cached:p.refresh!==true};
 }
 if(name==='getSegmentMailings')return {services:[service(p.segmentId)]};
 if(name==='refreshColdyMailings')return service(p.segmentId);
 if(name==='saveColdyBinding'){if(backend.receipts[p.requestId])return clone(backend.receipts[p.requestId]);const existing=backend.bindings.find(x=>x.campaignId===p.campaignId);if(existing&&existing.segmentId!==p.segmentId)throw new Error('[COLDY_CAMPAIGN_BOUND] Bound elsewhere');if(existing&&p.preserveExisting)return backend.receipts[p.requestId]={binding:clone(existing)};const binding={...p,id:'binding-created-0000001',campaignName:'New campaign',revision:1};backend.bindings.push(binding);backend.saveMutations++;const result={binding};backend.receipts[p.requestId]=clone(result);if(backend.failAfterSave){backend.failAfterSave=false;throw new Error('[GOOGLE_ERROR] Ответ потерян');}return result;}
 if(name==='removeColdyBinding'){if(backend.receipts[p.requestId])return clone(backend.receipts[p.requestId]);backend.bindings=backend.bindings.filter(x=>x.id!==p.bindingId);return backend.receipts[p.requestId]={removed:true};}
 if(name==='getProjectInfrastructureSelection')return selectionDto(p.query);
 if(name==='saveProjectInfrastructureSelection'){
  const previous=backend.monitoringReceipts[p.requestId];if(previous){if(JSON.stringify(previous.payload)!==JSON.stringify(p))throw new Error('[COLDY_MONITORING_REQUEST_MISMATCH] Request changed');return {selection:monitoring(),infrastructure:infra(),replayed:true,savedRevision:previous.revision};}
  if(p.scopeToken!==backend.monitoringScope)throw new Error('[COLDY_MONITORING_SCOPE_CHANGED] Scope changed');
  if(p.expectedRevision!==backend.monitoringRevision)throw new Error('[COLDY_MONITORING_STALE] Selection changed');
  if(p.accountIds.some(id=>!inventory().some(item=>item.id===id)))throw new Error('[COLDY_MONITORING_ACCOUNT_MISSING] Mailbox missing');
  backend.monitoringIds=[...p.accountIds];backend.monitoringRevision++;backend.monitoringConfigured=true;backend.infraSynced=false;backend.infraContinued=false;backend.largeCompleted=0;backend.monitoringReceipts[p.requestId]={payload:clone(p),revision:backend.monitoringRevision};
  if(backend.failAfterMonitoringSave){backend.failAfterMonitoringSave=false;throw new Error('[GOOGLE_ERROR] Lost acknowledgement');}
  return {selection:monitoring(),infrastructure:infra()};
 }
 if(name==='getProjectInfrastructure'){if(backend.infraErrorDto)return {state:'error',configured:true,connected:true,accounts:[],totals:{accounts:null,sentTotal:null,sentToday:null,errorCount:null,accountsWithErrors:null},lastSyncAt:null,nextCursor:null,error:{code:'COLDY_HTTP',message:'Inventory unavailable'},syncPaused:true};const value=infra();if(backend.cacheStale)value.stale=true;return value;}
 if(name==='refreshProjectInfrastructure'){
  if(backend.failInfra)throw new Error('[COLDY_HTTP] API temporarily unavailable');
  if(p.inventoryOnly){backend.inventoryLoaded=true;return infra();}
  if(p.cursor&&p.cursor!==infra().nextCursor)throw new Error('Incorrect cursor');
  if(!p.cursor)backend.syncMode=p.includeCapacity?'pool':'diagnostics';
  if(backend.syncMode==='pool'){
   backend.infraSynced=true;backend.cacheStale=false;
   backend.poolPending=backend.monitoringIds.includes('account-0')&&(!p.cursor||!!backend.sameCursor);
  }else{
   if(!p.cursor)backend.detailIds=[];
   const start=backend.detailIds.length;backend.detailIds.push(...backend.monitoringIds.slice(start,start+5));
  }
  const value=infra();if(backend.pauseFirst&&value.nextCursor)Object.assign(value,{syncPaused:true,retryAfterMs:15000,error:{code:'COLDY_RATE_LIMIT',message:'Rate limited'}});return value;
 }
 throw new Error('Unexpected RPC '+name);
}
window.transport=(name,p,guard)=>{
 if(guard&&!guard())return Promise.resolve(null);
 backend.calls.push({name,payload:clone(p)});backend.active++;const write=['saveColdyBinding','removeColdyBinding','saveProjectInfrastructureSelection'].includes(name);if(write){backend.activeWrites++;backend.maxWrites=Math.max(backend.maxWrites,backend.activeWrites);}
 return new Promise((resolve,reject)=>{const run=()=>{let value,error;try{value=guard&&!guard()?null:clone(api(name,p));}catch(e){error=e;}const finish=()=>{backend.active--;if(write)backend.activeWrites--;if(error)reject(error);else resolve(value);};if(backend.holdMethods.includes(name))backend.pending.push({name,finish});else setTimeout(finish,8);};if(backend.holdBeforeMethods?.includes(name))backend.pending.push({name,finish:run});else run();});
};
window.release=name=>{const item=backend.pending.find(x=>x.name===name);if(!item)throw new Error('No held '+name);backend.pending.splice(backend.pending.indexOf(item),1);item.finish();};
window.start=(view='analytics',epoch=1)=>{RegistryProject.configure({transport,openConnection:()=>backend.connectionOpens++,onStateChange:()=>{}});RegistryProject.show(view,{ready:true,epoch});void RegistryProject.refresh({opening:true});};
"""

def source(name):
    return (ROOT / 'src' / name).read_text(encoding='utf-8')

HTML = ('<!doctype html><html lang="ru"><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + source('Styles.html') + source('ProjectStyles.html')
        + '<div id="bases-registry-app">' + source('ProjectPanel.html') + '</div>'
        + '<script>' + FIXTURE + '</script>' + source('ProjectClient.html') + '</html>')

# The integrated scenario executes the real Client, header, dispatcher bridge
# and new fragments. Its provider API remains the same local fake above.
INTEGRATED_PROJECT = FIXTURE.replace('window.backend={','window.backend=Object.assign(window.backend||{},{',1).replace(
    "lastSyncAt:'2026-11-22T09:00:00Z'};", "lastSyncAt:'2026-11-22T09:00:00Z'});",1).replace(
    'function api(name,p)', 'function projectApi(name,p)').replace('clone(api(name,p))','clone(projectApi(name,p))')
INTEGRATED_PROJECT = '(function(){'+INTEGRATED_PROJECT+r"""
for(const method of ['getProjectAnalytics','getProjectAnalyticsCampaigns','getSegmentMailings','refreshColdyMailings','saveColdyBinding','removeColdyBinding','getProjectInfrastructure','refreshProjectInfrastructure','getProjectInfrastructureSelection','saveProjectInfrastructureSelection'])api[method]=payload=>projectApi(method,payload);
api.getColdySettings=()=>({configured:backend.configured,connected:backend.connected,emailValidationProvider:'promouser',manualValidation:true,autoValidateEmails:false});
api.testColdyConnection=()=>({connected:true,campaignCount:3});
api.configureColdy=p=>({configured:true,connected:true,emailValidationProvider:p.emailValidationProvider,manualValidation:true,autoValidateEmails:false,credentialChanged:!!p.apiKey});
})();
"""

def integrated_html():
    import re
    fixture = (ROOT/'tests/browser/performance-fixture.js').read_text(encoding='utf-8')
    def include(match):
        name=match.group(1)
        return ('<script>'+fixture+INTEGRATED_PROJECT+'</script>' if name=='Client' else '')+source(name+'.html')
    return re.sub(r"<\?!= include_\('([A-Za-z0-9_]+)'\); \?>",include,source('Index.html'))

def main():
    with sync_playwright() as p:
        launch = {'channel':'chrome'} if sys.platform=='win32' else {'executable_path':'/usr/bin/chromium'}
        browser = p.chromium.launch(**launch,headless=True,args=['--no-sandbox'])
        page = browser.new_page(viewport={'width':1440,'height':1000})
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))

        def reset(view='analytics',setup=''):
            page.goto('about:blank');page.set_content(HTML)
            if setup:page.evaluate(setup)
            page.evaluate('view=>start(view)',view);idle()

        def idle():
            page.wait_for_function('backend.active===0&&!RegistryProject.isLoading()')

        def count(method):
            return page.evaluate('method=>backend.calls.filter(x=>x.name===method).length',method)

        def find_campaign(query):
            if not page.locator('#pj-campaign-search').is_visible():
                page.locator('#pj-selection-open').click()
            page.locator('#pj-campaign-search').fill(query)
            page.locator('#pj-campaign-find').click()
            idle()

        monitored_setup="backend.monitoringIds=Array.from({length:6},(_,i)=>'account-'+i);backend.monitoringConfigured=true;"

        def reset_monitored(setup=''):
            reset('infrastructure',setup=monitored_setup+setup)

        def open_mailboxes():
            page.locator('#pj-infrastructure-select').click()
            expect(page.locator('#pj-mailbox-dialog')).to_be_visible();idle()

        def find_mailbox(query):
            page.locator('#pj-mailbox-search').fill(query)
            page.locator('#pj-mailbox-inventory').click();idle()

        reset()
        expect(page.locator('#pj-segment')).to_be_enabled()
        page.locator('#pj-segment').select_option('segment-a');idle()
        expect(page.locator('[data-project-campaign="'+ '11111111-1111-4111-8111-111111111111' +'"]')).to_be_checked()
        expect(page.locator('[data-project-campaign="33333333-3333-4333-8333-333333333333"]')).to_have_count(0)
        expect(page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]')).to_have_count(0)
        assert all('query' not in call.get('payload',{}) for call in page.evaluate("backend.calls.filter(c=>c.name==='getProjectAnalyticsCampaigns')"))
        find_campaign('campaign')
        expect(page.locator('[data-project-campaign="33333333-3333-4333-8333-333333333333"]')).to_be_disabled()
        assert page.locator('#pj-analytics-totals dd').all_text_contents()==['100','5','—']
        assert page.locator('#pj-campaign-rows img').count()==0
        original=page.evaluate('JSON.parse(JSON.stringify(backend.bindings[0]))')
        page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]').check()
        page.locator('[data-remove-project-campaign="44444444-4444-4444-8444-444444444444"]').click()
        page.evaluate('backend.failAfterSave=true')
        page.locator('#pj-selection-save').click();idle()
        expect(page.locator('#pj-selection-retry')).to_be_visible()
        assert count('removeColdyBinding')==0,'No next step after an unknown result'
        assert page.evaluate('backend.saveMutations')==1
        page.evaluate('RegistryProject.invalidate()')
        expect(page.locator('#pj-selection-retry')).to_be_visible()
        page.locator('#pj-selection-retry').click();idle()
        calls=page.evaluate("backend.calls.filter(x=>x.name==='saveColdyBinding')")
        assert len(calls)==2 and calls[0]['payload']['requestId']==calls[1]['payload']['requestId']
        assert calls[0]['payload']['autoUpload'] is False and calls[0]['payload']['allowActive'] is False
        assert calls[0]['payload']['preserveExisting'] is True
        assert calls[0]['payload']['includeCompanies'] is True and calls[0]['payload']['includeLpr'] is True
        assert page.evaluate('backend.bindings.find(x=>x.campaignId===A)')==original
        assert page.evaluate('backend.maxWrites')==1
        assert count('removeColdyBinding')==1
        assert not any(x['name'].startswith(('start','previewColdyUpload','testColdy')) for x in page.evaluate('backend.calls'))
        assert page.locator('#pj-selection-save').is_disabled()

        reset();page.locator('#pj-segment').select_option('segment-a');idle();find_campaign('New campaign')
        page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]').check()
        teammate=page.evaluate("(()=>{const binding={id:'teammate-binding-0000001',segmentId:'segment-a',campaignId:B,campaignName:'New campaign',includeCompanies:false,includeLpr:true,autoUpload:true,allowActive:true,revision:7};backend.bindings.push(binding);return JSON.parse(JSON.stringify(binding));})()")
        page.locator('#pj-selection-save').click();idle()
        assert page.evaluate('backend.bindings.find(x=>x.campaignId===B)')==teammate
        assert page.evaluate('backend.saveMutations')==0,'Concurrent same-segment binding retains every setting'

        # Opening a large account returns only monitored campaigns. Explicit searches preserve previous choices.
        reset(setup="""backend.extraCampaigns=Array.from({length:1200},(_,i)=>({id:'bulk-'+i,name:'Архив '+i,status:'Draft'}));
backend.extraCampaigns.push({id:'kitchen',name:'Намшилд / Кухни ЛПР',status:'Active'},{id:'pinned',name:'Привязана в конце',status:'Active'});
backend.bindings.push({id:'binding-pinned',segmentId:'segment-a',campaignId:'pinned',campaignName:'Привязана в конце',revision:1});""")
        page.locator('#pj-segment').select_option('segment-a');idle()
        campaign_rows=page.locator('#pj-campaign-rows tr')
        search=page.locator('#pj-campaign-search')
        expect(campaign_rows).to_have_count(3)
        expect(page.locator('[data-project-campaign="pinned"]')).to_be_checked()
        reads=count('getProjectAnalyticsCampaigns')
        find_campaign('Архив');expect(page.locator('#pj-selection-health')).to_contain_text('первые 40')
        find_campaign('КУХНИ лпр');expect(campaign_rows).to_have_count(4)
        page.locator('[data-project-campaign="kitchen"]').check()
        find_campaign('Архив 1199')
        page.locator('[data-project-campaign="bulk-1199"]').check()
        find_campaign('Совсем другой запрос')
        expect(page.locator('#pj-selection-health')).to_contain_text('В сохранённом справочнике совпадений нет')
        expect(page.locator('#pj-selection-count')).to_have_text('Выбрано: 5')
        assert count('getProjectAnalyticsCampaigns')==reads+4
        assert page.evaluate("backend.calls.filter(c=>c.name==='getProjectAnalyticsCampaigns'&&c.payload.refresh&&c.payload.query).length") == 0
        page.locator('#pj-campaign-extend').click();idle()
        expect(page.locator('#pj-selection-health')).to_contain_text('По этому запросу рассылок нет')
        page.locator('#pj-selection-save').click();idle()
        assert {x['campaignId'] for x in page.evaluate("backend.bindings.filter(b=>b.segmentId==='segment-a')")}=={
            '11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','kitchen','bulk-1199','pinned'}
        assert count('removeColdyBinding')==0
        page.locator('#pj-segment').select_option('segment-b');idle();expect(search).to_have_value('')
        page.locator('#pj-selection-open').click();search.fill('чужой поиск');page.evaluate('RegistryProject.lock()');expect(search).to_have_value('')

        # Refresh rebases explicit user changes instead of deleting a teammate's binding.
        for clean in [False,True]:
            reset();page.locator('#pj-segment').select_option('segment-a');idle();find_campaign('New')
            chosen=page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]')
            chosen.check()
            if clean:chosen.uncheck()
            page.evaluate("backend.bindings.find(x=>x.campaignId===C).segmentId='segment-a'")
            page.locator('#pj-analytics-refresh').click();idle()
            expect(page.locator('[data-project-campaign="33333333-3333-4333-8333-333333333333"]')).to_be_checked()
            if clean:expect(page.locator('#pj-selection-save')).to_be_disabled()
            else:
                chosen.check();page.locator('#pj-selection-save').click();idle()
                assert count('removeColdyBinding')==0
                assert page.evaluate("backend.bindings.find(x=>x.campaignId===C).segmentId")=='segment-a'

        for state in ['source_missing','source_ambiguous','source_outside_registry']:
            reset(setup='backend.catalogState='+json.dumps(state))
            assert 'Сегментов пока нет' not in page.locator('#pj-analytics-empty').inner_text()

        # Late segment A response cannot replace segment B's chooser or summaries.
        reset(setup="backend.holdMethods=['getProjectAnalyticsCampaigns']")
        page.locator('#pj-segment').select_option('segment-a')
        page.wait_for_function("backend.pending.some(x=>x.name==='getProjectAnalyticsCampaigns')")
        page.evaluate('backend.holdMethods=[]')
        page.locator('#pj-segment').select_option('segment-b');page.wait_for_function('backend.active===1')
        expect(page.locator('[data-project-campaign="33333333-3333-4333-8333-333333333333"]')).to_be_checked()
        page.evaluate("release('getProjectAnalyticsCampaigns')");idle()
        assert page.locator('#pj-segment').input_value()=='segment-b'
        expect(page.locator('[data-project-campaign="33333333-3333-4333-8333-333333333333"]')).to_be_checked()

        reset('infrastructure',setup='backend.configured=false;backend.connected=false')
        assert count('refreshProjectInfrastructure')==0
        page.locator('#pj-infrastructure-connect').click()
        assert page.evaluate('backend.connectionOpens')==1
        assert page.locator('#pj-infrastructure-totals dd').all_text_contents() == ['—','—','—','—']

        reset_monitored()
        assert count('refreshProjectInfrastructure')==2,'Finite pagination completes both batches'
        expect(page.locator('#pj-infrastructure-continue')).to_be_hidden()
        assert page.locator('#pj-account-rows tr').count()==6
        assert page.locator('#pj-account-rows img').count()==0
        expect(page.locator('#pj-infrastructure-totals dd')).to_have_text(['6','4','1','1'])
        sender=page.locator('#pj-account-rows tr[data-account="account-0"]')
        expect(sender).to_contain_text('Проект 2 / Кухни')
        expect(sender).to_contain_text('Без сегмента')
        expect(sender).to_contain_text('23.11.2026')
        expect(sender).to_contain_text('Дата неизвестна')
        expect(page.locator('#pj-schedule-rows tr')).to_have_count(2)
        expect(page.locator('#pj-schedule-rows')).not_to_contain_text('Только в другом пуле')
        expect(page.locator('#pj-schedule-rows')).to_contain_text('Пн–Пт · 09:00–18:30')
        expect(page.locator('#pj-schedule-rows')).to_contain_text('Ожидает расписания')
        expect(page.locator('#pj-schedule-rows')).to_contain_text('График неизвестен')
        sender.get_by_role('button',name='Показать расписание · Намшилд / Кухни').click()
        assert page.evaluate("document.activeElement.id.startsWith('pj-schedule-')")
        page.locator('#pj-capacity-filter').select_option('free')
        expect(page.locator('#pj-account-rows tr')).to_have_count(4)
        expect(page.locator('#pj-account-rows [data-account="account-1"]')).to_contain_text('Проверьте подключение')
        page.locator('#pj-capacity-filter').select_option('unknown')
        expect(page.locator('#pj-account-rows tr')).to_have_count(1)
        expect(page.locator('#pj-account-rows')).to_contain_text('Нет подтверждённых данных')
        page.locator('#pj-capacity-filter').select_option('')
        assert not page.locator('#pj-infrastructure-diagnostics').evaluate('el=>el.open')
        page.locator('#pj-infrastructure-diagnostics summary').click()
        assert page.evaluate('backend.detailIds')==[]
        expect(page.locator('#pj-diagnostics-health')).to_contain_text('ещё не загружена')
        expect(page.locator('#pj-diagnostic-rows')).not_to_contain_text('<img')
        page.locator('#pj-diagnostics-refresh').click();idle()
        expect(page.locator('#pj-diagnostic-rows')).to_contain_text('<img')
        expect(page.locator('#pj-diagnostic-rows')).to_contain_text('Проверено')
        assert page.evaluate('backend.detailIds.length')==6
        assert page.locator('#pj-diagnostic-rows img').count()==0
        assert page.locator('#pj-diagnostic-rows tr').first.locator('td').nth(3).inner_text()=='—'
        page.wait_for_timeout(350)
        assert count('refreshProjectInfrastructure')==4,'Two schedule and two explicit diagnostics batches'
        calls=page.evaluate("backend.calls.filter(x=>x.name==='refreshProjectInfrastructure')")
        assert calls[0]['payload']=={'includeCapacity':True,'live':True}
        assert [call['payload'] for call in calls[1:]]==[{'cursor':'pool-schedule-cursor'},{},{'cursor':'details-5'}]
        assert page.locator('#pj-account-rows tr').count()==6
        expect(page.locator('#pj-infrastructure-continue')).to_be_hidden()
        page.evaluate("backend.senderName='Обновлённое имя '")
        page.locator('#pj-infrastructure-refresh').click();idle()
        expect(sender).to_contain_text('Обновлённое имя 0')
        assert page.evaluate('backend.monitoringIds.length')==6
        page.evaluate('backend.uncertainCapacity=true')
        page.locator('#pj-infrastructure-refresh').click();idle()
        expect(page.locator('#pj-infrastructure-totals dd')).to_have_text(['6','0','0','6'])
        expect(page.locator('#pj-infrastructure-note')).to_contain_text('последние сохранённые')
        page.evaluate('backend.failInfra=true')
        page.locator('#pj-infrastructure-refresh').click();idle()
        assert page.locator('#pj-account-rows tr').count()==6,'Old safe values survive refresh failure'
        assert 'unavailable' in page.locator('#pj-infrastructure-health').inner_text()
        previous=count('refreshProjectInfrastructure');page.wait_for_timeout(350)
        assert count('refreshProjectInfrastructure')==previous

        # NONE is the default even with 1159 cached mailboxes. Search is local
        # and bounded; a saved shared choice never starts provider work.
        reset('infrastructure',setup='backend.largeInventory=1159')
        assert count('refreshProjectInfrastructure')==0
        assert page.locator('#pj-account-rows tr').count()==0
        expect(page.locator('#pj-infrastructure-empty')).to_contain_text('Выберите почты для мониторинга')
        open_mailboxes()
        assert page.locator('#pj-mailbox-rows input').count()==0
        assert page.locator('#pj-mailbox-rows input:checked').count()==0
        search=page.locator('#pj-mailbox-search')
        find_mailbox('LARGE-SENDER-1158@EXAMPLE.TEST')
        assert page.locator('#pj-mailbox-rows input').count()==1
        page.locator('[data-monitoring-account="account-1158"]').check()
        find_mailbox('large-sender-1@example.test')
        page.locator('[data-monitoring-account="account-1"]').check()
        expect(page.locator('#pj-mailbox-count')).to_contain_text('Выбрано: 2')
        assert count('refreshProjectInfrastructure')==0
        page.locator('#pj-mailbox-save').click();idle()
        expect(page.locator('#pj-mailbox-dialog')).to_be_hidden()
        assert page.evaluate('backend.monitoringIds')==['account-1','account-1158']
        assert count('saveProjectInfrastructureSelection')==1
        assert count('refreshProjectInfrastructure')==0,'Selection save is metadata-only'
        assert page.locator('#pj-account-rows tr').count()==2
        assert page.locator('#pj-infrastructure-totals dd').all_text_contents()==['2','0','0','2']
        page.locator('#pj-infrastructure-refresh').click();idle()
        assert page.evaluate('backend.detailIds')==[]
        assert count('refreshProjectInfrastructure')==1,'Free mailboxes need no schedule or detail request'
        assert page.locator('#pj-infrastructure-totals dd').all_text_contents()==['2','2','0','0']
        assert 'large-sender-0@example.test' not in page.locator('#pj-account-rows').inner_text()
        assert page.locator('#pj-account-rows img').count()==0
        page.wait_for_timeout(350)
        assert count('refreshProjectInfrastructure')==1

        # A fresh client reads the team's saved selection. Cancel discards a
        # local change; clear persists an empty selection and stops refreshes.
        reset('infrastructure',setup="backend.largeInventory=1159;backend.monitoringIds=['account-1','account-1158'];backend.monitoringConfigured=true;backend.monitoringRevision=1;backend.infraSynced=true;backend.largeCompleted=2;backend.lastSyncAt=new Date(Date.now()).toISOString()")
        assert count('refreshProjectInfrastructure')==0
        assert page.locator('#pj-account-rows tr').count()==2
        open_mailboxes();page.locator('#pj-mailbox-clear').click()
        page.locator('#pj-mailbox-cancel').click()
        assert page.locator('#pj-account-rows tr').count()==2
        open_mailboxes();expect(page.locator('#pj-mailbox-count')).to_contain_text('Выбрано: 2')
        page.locator('#pj-mailbox-clear').click();page.locator('#pj-mailbox-save').click();idle()
        assert page.evaluate('backend.monitoringIds')==[]
        assert page.locator('#pj-account-rows tr').count()==0
        expect(page.locator('#pj-infrastructure-refresh')).to_be_disabled()
        assert count('refreshProjectInfrastructure')==0

        # An empty cached catalog is populated only by the explicit inventory
        # action. Even that action may not fan out into mailbox detail reads.
        reset('infrastructure',setup='backend.largeInventory=1159;backend.inventoryLoaded=false')
        open_mailboxes()
        assert page.locator('#pj-mailbox-rows input').count()==0
        assert count('refreshProjectInfrastructure')==0
        find_mailbox('large-sender-1158@example.test')
        assert page.locator('#pj-mailbox-rows input').count()==1
        assert count('refreshProjectInfrastructure')==0
        assert page.evaluate("backend.calls.filter(call=>call.name==='getProjectInfrastructureSelection').map(call=>call.payload)")==[{}, {'query':'large-sender-1158@example.test'}]
        assert page.evaluate('backend.detailIds')==[]
        page.locator('#pj-mailbox-cancel').click()

        # Unknown acknowledgement keeps the exact UUID/payload through soft
        # invalidation and reopening. A newer teammate selection wins on replay.
        reset('infrastructure',setup='backend.largeInventory=1159')
        open_mailboxes();find_mailbox('account-0');page.locator('[data-monitoring-account="account-0"]').check()
        page.evaluate('backend.failAfterMonitoringSave=true')
        page.locator('#pj-mailbox-save').click();idle()
        expect(page.locator('#pj-mailbox-retry')).to_be_visible()
        expect(page.locator('#pj-mailbox-search')).to_be_disabled()
        frozen=page.evaluate("backend.calls.find(call=>call.name==='saveProjectInfrastructureSelection').payload")
        page.evaluate('RegistryProject.invalidate()')
        expect(page.locator('#pj-mailbox-retry')).to_be_visible()
        page.locator('#pj-mailbox-cancel').click();open_mailboxes()
        assert count('getProjectInfrastructureSelection')==2
        expect(page.locator('#pj-mailbox-retry')).to_be_visible()
        page.evaluate("backend.monitoringIds=['account-2'];backend.monitoringRevision++")
        page.locator('#pj-mailbox-retry').click();idle()
        saved=page.evaluate("backend.calls.filter(call=>call.name==='saveProjectInfrastructureSelection').map(call=>call.payload)")
        assert saved==[frozen,frozen]
        assert page.evaluate('backend.monitoringIds')==['account-2']
        assert page.locator('#pj-account-rows tr').count()==1
        expect(page.locator('#pj-account-rows')).to_contain_text('large-sender-2@example.test')
        expect(page.locator('#pj-infrastructure-health')).to_contain_text('коллега изменил выбор')
        assert count('refreshProjectInfrastructure')==0

        # A known optimistic conflict does not retry or overwrite a teammate.
        # Loading the saved selection is an explicit review action.
        reset('infrastructure')
        open_mailboxes();find_mailbox('account-0');page.locator('[data-monitoring-account="account-0"]').check()
        page.evaluate("backend.monitoringIds=['account-1'];backend.monitoringRevision=1;backend.monitoringConfigured=true")
        page.locator('#pj-mailbox-save').click();idle()
        expect(page.locator('#pj-mailbox-reload')).to_be_visible()
        expect(page.locator('#pj-mailbox-save')).to_be_disabled()
        expect(page.locator('#pj-mailbox-retry')).to_be_hidden()
        assert page.evaluate('backend.monitoringIds')==['account-1']
        page.locator('#pj-mailbox-reload').click();idle()
        expect(page.locator('[data-monitoring-account="account-1"]')).to_be_checked()
        expect(page.locator('[data-monitoring-account="account-0"]')).to_have_count(0)
        assert count('saveProjectInfrastructureSelection')==1
        page.locator('#pj-mailbox-cancel').click()

        # A hard credential/access reset scrubs both the picker and its frozen
        # operation. A held old response cannot reopen or repopulate the dialog.
        reset('infrastructure')
        open_mailboxes();find_mailbox('account-0');page.locator('[data-monitoring-account="account-0"]').check()
        page.evaluate("backend.holdMethods=['saveProjectInfrastructureSelection']")
        page.locator('#pj-mailbox-save').click()
        page.wait_for_function("backend.pending.some(call=>call.name==='saveProjectInfrastructureSelection')")
        page.evaluate("RegistryProject.invalidate({credentialsChanged:true});backend.monitoringScope='new-key-scope';backend.monitoringIds=[];backend.holdMethods=[];release('saveProjectInfrastructureSelection')")
        idle()
        expect(page.locator('#pj-mailbox-dialog')).to_be_hidden()
        assert page.locator('#pj-mailbox-rows').inner_text()==''
        open_mailboxes()
        expect(page.locator('#pj-mailbox-retry')).to_be_hidden()
        expect(page.locator('#pj-mailbox-count')).to_contain_text('Выбрано: 0')
        page.evaluate('RegistryProject.lock()')
        expect(page.locator('#pj-mailbox-dialog')).to_be_hidden()
        assert page.locator('#pj-mailbox-rows').inner_text()==''

        # Leaving before a queued save is dispatched cancels the stale write.
        # Reopening offers the same UUID so its outcome can be confirmed safely.
        reset('infrastructure')
        open_mailboxes();find_mailbox('account-0');page.locator('[data-monitoring-account="account-0"]').check()
        page.evaluate("backend.holdBeforeMethods=['saveProjectInfrastructureSelection']")
        page.locator('#pj-mailbox-save').click()
        page.wait_for_function("backend.pending.some(call=>call.name==='saveProjectInfrastructureSelection')")
        queued=page.evaluate("backend.calls.find(call=>call.name==='saveProjectInfrastructureSelection').payload")
        page.evaluate("RegistryProject.show('analytics',{ready:true,epoch:1});backend.holdBeforeMethods=[];release('saveProjectInfrastructureSelection')")
        page.wait_for_function('backend.active===0')
        expect(page.locator('#pj-mailbox-dialog')).to_be_hidden()
        assert page.evaluate('backend.monitoringIds')==[]
        assert page.evaluate('Object.keys(backend.monitoringReceipts).length')==0
        assert page.locator('#pj-mailbox-rows').inner_text()==''
        page.evaluate("RegistryProject.show('infrastructure',{ready:true,epoch:1})")
        open_mailboxes();expect(page.locator('#pj-mailbox-retry')).to_be_visible()
        page.locator('#pj-mailbox-retry').click();idle()
        assert page.evaluate("backend.calls.filter(call=>call.name==='saveProjectInfrastructureSelection').at(-1).payload")==queued
        assert page.evaluate('backend.monitoringIds')==['account-0']

        reset_monitored(setup='backend.infraSynced=true;backend.cacheStale=true')
        assert count('refreshProjectInfrastructure')==2,'One stale-cache refresh completes the finite run'
        page.wait_for_timeout(350)
        assert count('refreshProjectInfrastructure')==2,'Stale marker cannot become a polling loop'
        reset('infrastructure',setup='backend.infraErrorDto=true')
        assert page.locator('#pj-infrastructure-totals dd').all_text_contents()==['—','—','—','—']
        assert 'Inventory unavailable' in page.locator('#pj-infrastructure-health').inner_text()
        for setup,expected_calls in [('backend.pauseFirst=true',1),('backend.sameCursor=true',2)]:
            reset_monitored(setup=setup)
            assert count('refreshProjectInfrastructure')==expected_calls
            page.wait_for_timeout(350)
            assert count('refreshProjectInfrastructure')==expected_calls,'Pause/cursor failure cannot spin'
            expect(page.locator('#pj-infrastructure-continue')).to_be_visible()

        # Only the diagnostic control resumes a paused detail run; reopening cannot start pool work over it.
        reset_monitored()
        page.evaluate('backend.pauseFirst=true')
        page.locator('#pj-infrastructure-diagnostics summary').click()
        page.locator('#pj-diagnostics-refresh').click();idle()
        expect(page.locator('#pj-diagnostics-refresh')).to_have_text('Продолжить диагностику')
        expect(page.locator('#pj-infrastructure-continue')).to_be_hidden()
        writes=count('refreshProjectInfrastructure')
        page.evaluate("RegistryProject.show('analytics',{ready:true,epoch:1});RegistryProject.show('infrastructure',{ready:true,epoch:1});void RegistryProject.refresh({opening:true})")
        idle()
        assert count('refreshProjectInfrastructure')==writes
        page.evaluate('backend.pauseFirst=false')
        page.locator('#pj-diagnostics-refresh').click();idle()
        assert page.evaluate("backend.calls.filter(x=>x.name==='refreshProjectInfrastructure').at(-1).payload")=={'cursor':'details-5'}
        expect(page.locator('#pj-diagnostics-refresh')).to_have_text('Обновить диагностику')

        # Leaving the view pauses the finite run; Continue resumes its exact cursor.
        page.goto('about:blank');page.set_content(HTML)
        page.evaluate(monitored_setup+"backend.holdMethods=['refreshProjectInfrastructure'];start('infrastructure')")
        page.wait_for_function("backend.pending.some(x=>x.name==='refreshProjectInfrastructure')")
        page.evaluate("RegistryProject.show('analytics',{ready:true,epoch:1});backend.backgroundMutations=0;new MutationObserver(()=>backend.backgroundMutations++).observe(document.querySelector('#pj-account-rows'),{childList:true,subtree:true});backend.holdMethods=[];release('refreshProjectInfrastructure')")
        page.wait_for_function('backend.active===0')
        assert count('refreshProjectInfrastructure')==1
        assert page.evaluate('backend.backgroundMutations')==0,'A late response does not rebuild an offscreen inventory'
        page.evaluate("RegistryProject.show('infrastructure',{ready:true,epoch:1});void RegistryProject.refresh({opening:true})")
        idle();expect(page.locator('#pj-infrastructure-continue')).to_be_visible()
        page.locator('#pj-infrastructure-continue').click();idle()
        assert count('refreshProjectInfrastructure')==2

        # Credential rotation stops a started finite sync before its next batch.
        page.goto('about:blank');page.set_content(HTML)
        page.evaluate(monitored_setup+"backend.holdMethods=['refreshProjectInfrastructure'];start('infrastructure')")
        page.wait_for_function("backend.pending.some(x=>x.name==='refreshProjectInfrastructure')")
        page.evaluate("RegistryProject.invalidate({credentialsChanged:true});release('refreshProjectInfrastructure')")
        page.wait_for_function('backend.active===0')
        assert count('refreshProjectInfrastructure')==1
        assert page.locator('#pj-account-rows').inner_text()==''

        # Revocation clears actual DOM values, not only the visible panel.
        page.evaluate("RegistryProject.lock()")
        assert page.locator('#pj-account-rows').inner_text()==''
        assert page.locator('#pj-campaign-rows').inner_text()==''
        page.goto('about:blank');page.set_content(HTML)
        page.evaluate(monitored_setup+"backend.infraSynced=true;backend.holdMethods=['getProjectInfrastructure'];backend.accountMarker='private-old';start('infrastructure')")
        page.wait_for_function("backend.pending.some(x=>x.name==='getProjectInfrastructure')")
        page.evaluate("RegistryProject.lock();backend.holdMethods=[];backend.accountMarker='new-scope';start('infrastructure',2)")
        page.wait_for_function("document.querySelector('#pj-account-rows')?.textContent.includes('new-scope')")
        page.evaluate("release('getProjectInfrastructure')");idle()
        assert 'private-old' not in page.locator('#pj-account-rows').inner_text()

        reset()
        page.locator('#pj-segment').select_option('segment-a');idle()
        find_campaign('New')
        page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]').check()
        page.locator('[data-remove-project-campaign="44444444-4444-4444-8444-444444444444"]').click()
        page.evaluate("backend.holdMethods=['saveColdyBinding']")
        page.locator('#pj-selection-save').click()
        page.wait_for_function("backend.pending.some(x=>x.name==='saveColdyBinding')")
        page.evaluate("RegistryProject.lock();release('saveColdyBinding')")
        page.wait_for_function('backend.active===0')
        assert count('removeColdyBinding')==0,'Revocation stops the remaining save steps'
        assert page.locator('#pj-campaign-rows').inner_text()==''

        # Real navigation and central connection dialog use the shared transport.
        page.goto('about:blank');page.set_content(integrated_html())
        page.wait_for_function('backend.sourceGets>0&&backend.active===0')
        page.evaluate("backend.segments[0].id='segment-a';backend.segments[0].coldyMailings={linked:1,activeAtBinding:1,previewNames:['Название из обзора сегментов']}")
        page.locator('#br-view-segments').click()
        expect(page.locator('[data-segment="segment-a"]')).to_be_visible()
        page.evaluate("backend.holdMethods=['getProjectAnalyticsCampaigns']")
        page.locator('#br-view-analytics').click()
        expect(page.locator('#pj-analytics-view')).to_be_visible()
        expect(page.locator('#br-view-analytics')).to_have_attribute('aria-pressed','true')
        page.locator('#pj-segment').select_option('segment-a')
        expect(page.locator('#pj-campaign-rows')).to_contain_text('Название из обзора сегментов')
        expect(page.locator('#pj-campaign-rows input, #pj-campaign-rows button')).to_have_count(0)
        page.wait_for_function("backend.pending.some(x=>x.method==='getProjectAnalyticsCampaigns')")
        page.evaluate("backend.holdMethods=[];releaseRpc('getProjectAnalyticsCampaigns')");idle()
        expect(page.locator('#pj-campaign-rows')).not_to_contain_text('Название из обзора сегментов')
        page.locator('#pj-analytics-connect').click()
        expect(page.locator('#br-coldy-dialog')).to_be_visible()
        page.wait_for_function('backend.active===0')
        page.locator('#br-coldy-close').click()
        page.locator('#br-settings-close').click()
        find_campaign('New')
        page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]').check()
        assert page.evaluate('RegistryProject.isEditing()') is True
        before=count('getProjectAnalyticsCampaigns')
        page.locator('#br-view-infrastructure').click();idle()
        expect(page.locator('#pj-infrastructure-view')).to_be_visible()
        assert page.locator('#pj-account-rows tr').count()==0
        assert count('refreshProjectInfrastructure')==0
        infra_reads=count('getProjectInfrastructure')
        page.locator('#br-view-analytics').click()
        page.locator('#br-view-infrastructure').click();idle()
        assert count('getProjectInfrastructure')==infra_reads,'Fresh project infrastructure is reused on a quick return'
        open_mailboxes();find_mailbox('account-0');page.locator('[data-monitoring-account="account-0"]').check()
        page.locator('#pj-mailbox-save').click();idle()
        assert page.locator('#pj-account-rows tr').count()==1
        page.locator('#br-view-analytics').click();idle()
        expect(page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]')).to_be_checked()
        assert count('getProjectAnalyticsCampaigns')==before,'Warm opening preserves the unsaved chooser'
        page.locator('#br-refresh').click();idle()
        expect(page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]')).to_be_checked()
        expect(page.locator('#pj-selection-save')).to_be_enabled()
        page.locator('#pj-analytics-connect').click();idle()
        page.locator('#br-coldy-test').click();idle()
        page.locator('#br-coldy-close').click();page.locator('#br-settings-close').click();idle()
        expect(page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]')).to_be_checked()
        page.locator('#pj-analytics-connect').click();idle()
        page.locator('#br-coldy-provider').select_option('coldy')
        page.locator('#br-coldy-save').click();idle()
        page.locator('#br-coldy-close').click();page.locator('#br-settings-close').click();idle()
        expect(page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]')).to_be_checked()
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'),'Five-tab header must not overflow mobile viewport'
        assert not any(call['name'].startswith(('startColdy','startPhone','payValidation','startPromouser')) for call in page.evaluate('backend.calls'))
        page.evaluate('RegistryProject.invalidate({credentialsChanged:true})')
        assert page.locator('#pj-segment').input_value()==''
        assert not page.evaluate('RegistryProject.isEditing()')
        assert page.locator('#pj-account-rows').inner_text()==''
        # A real origin gives this local fixture the same project preference storage as the app.
        scoped = integrated_html().replace('const MOCK_KEY=', """
backend.sources.forEach((item,i)=>{item.projectIds=i===0?['numshield']:[];item.projectsRevision=3;});
const MOCK_KEY=""").replace("function runner(){","""
const originalDashboard=api.getSegmentsDashboard;
const legacy=makeSegment('legacy','Сегмент без проекта','no_contacts');
api.getSegmentsDashboard=(p,project)=>{
 const result=originalDashboard(p);result.analysisPending=false;
 result.items=[makeSegment(project,project==='neosender'?'Сегмент Нео':'Сегмент Намшилд','no_contacts'),
 makeSegment(project+'-partner',project==='numshield'?'Веб-студии':'Партнеры Нео','no_contacts','partners')];
 if(backend.legacyProject===project)result.items.push(legacy);
 result.unassigned=backend.legacyProject?[]:[{id:legacy.id,name:legacy.name}];return result;
};
api.claimRegistrySegment=(p,project)=>{backend.legacyProject=project;return {segmentId:p.segmentId,projectId:project};};
api.updateSourceBase=p=>{
 const item=backend.sources.find(x=>x.id===p.id);
 if(backend.receipts[p.requestId])return backend.receipts[p.requestId];
 if(p.expectedRevision!==item.revision||p.expectedProjectsRevision!==item.projectsRevision)throw new Error('[CONFLICT] Changed');
 item.projectIds=p.projectIds;item.projectsRevision++;const result={item:clone(item)};backend.receipts[p.requestId]=result;
 if(backend.loseResponse){backend.loseResponse=false;throw new Error('Ответ потерян');}return result;
};
function runner(){""")
        page.route('https://registry.test/**',lambda route:route.fulfill(body=scoped,content_type='text/html; charset=utf-8'))
        page.goto('https://registry.test/')
        project=page.locator('#br-project')
        expect(project).to_have_value('numshield')
        row=page.locator('[data-source-id="source-companies"]')
        row.locator('.br-source-settings summary').click()
        expect(row.locator('[data-source-project="numshield"]')).to_be_checked()
        row.locator('[data-source-project="neosender"]').check()
        page.evaluate('backend.loseResponse=true')
        row.locator('[data-project-save]').click()
        expect(row.locator('[data-project-save]')).to_have_text('Повторить сохранение')
        row.locator('[data-project-save]').click()
        expect(row.locator('[data-project-save]')).to_have_count(0)
        requests=page.evaluate("backend.calls.filter(x=>x.name==='updateSourceBase').map(x=>x.p)")
        assert requests[0]==requests[1] and requests[0]['projectIds']==['numshield','neosender']
        page.locator('#br-source-project-filter').select_option('neosender')
        expect(page.locator('.br-source-item')).to_have_count(1)
        page.locator('#br-view-segments').click()
        expect(page.locator('#br-segments-rows')).to_contain_text('Сегмент Намшилд')
        page.locator('#br-segment-category-partners').click()
        expect(page.locator('#br-segments-rows')).to_contain_text('Веб-студии')
        expect(page.locator('#br-segments-rows')).not_to_contain_text('Сегмент Намшилд')
        # Capture a late read of the first project, then move into the second.
        page.evaluate("backend.holdAfterMethods=['getSegmentsDashboard']")
        page.locator('#br-refresh').click()
        page.wait_for_function("backend.pending.some(x=>x.method==='getSegmentsDashboard')")
        page.evaluate("backend.holdAfterMethods=[]")
        project.select_option('neosender')
        expect(page.locator('#br-segments-rows')).to_contain_text('Сегмент Нео')
        page.evaluate("backend.pending.shift().resolve()")
        page.wait_for_function('backend.active===0')
        expect(page.locator('#br-segments-rows')).not_to_contain_text('Сегмент Намшилд')
        page.locator('#br-segment-category-partners').click()
        expect(page.locator('#br-segments-rows')).to_contain_text('Партнеры Нео')
        expect(page.locator('#br-segments-rows')).not_to_contain_text('Веб-студии')
        page.locator('#br-segment-category-clients').click()
        expect(page.locator('[data-claim-segment="legacy"]')).to_contain_text('Нео Сендер')
        page.locator('[data-claim-segment="legacy"]').click()
        expect(page.locator('#br-segments-rows')).to_contain_text('Сегмент без проекта')
        expect(page.locator('#br-unassigned')).to_be_hidden()
        assert page.evaluate("backend.calls.find(x=>x.name==='claimRegistrySegment').projectId")=='neosender'
        assert set(page.evaluate("backend.transport.filter(x=>x.name==='callApp').map(x=>x.projectId)"))=={'neosender','numshield'}
        page.locator('#br-view-sources').click()
        expect(page.locator('#br-source-project-filter')).to_have_value('')
        assert page.locator('.br-source-item').count()>1
        page.reload()
        expect(project).to_have_value('neosender')
        assert page.evaluate("Object.keys(localStorage).map(key=>localStorage.getItem(key))")==['neosender']
        assert not errors,errors
        browser.close()
        print('PASS: segment campaigns, delta-only stable retries, flags preserved, sender sync chunks, unknown metrics, stale responses and access scrubbing.')

if __name__=='__main__':
    main()
