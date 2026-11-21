"""Analytics/infrastructure UI with held requests and local API fakes only."""
from pathlib import Path
import json
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = r"""
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333',D='44444444-4444-4444-8444-444444444444';
window.backend={configured:true,connected:true,calls:[],active:0,activeWrites:0,maxWrites:0,pending:[],holdMethods:[],receipts:{},failAfterSave:false,saveMutations:0,connectionOpens:0,infraSynced:false,infraContinued:false,failInfra:false,accountMarker:'sender',lastSyncAt:'2026-11-22T09:00:00Z'};
backend.bindings=[{id:'binding-existing-00000001',segmentId:'segment-a',campaignId:A,campaignName:'Existing campaign',includeCompanies:false,includeLpr:true,autoUpload:true,allowActive:true,revision:4},{id:'binding-other-0000000002',segmentId:'segment-b',campaignId:C,campaignName:'Other campaign',includeCompanies:true,includeLpr:false,autoUpload:false,allowActive:false,revision:1},{id:'binding-missing-00000003',segmentId:'segment-a',campaignId:D,campaignName:'Removed at provider',includeCompanies:true,includeLpr:true,autoUpload:false,allowActive:false,revision:1}];
const clone=x=>JSON.parse(JSON.stringify(x));
function campaigns(id){const rows=[{id:A,name:'Existing campaign',status:'Active'},{id:B,name:'New campaign',status:'Draft'},{id:C,name:'Other campaign',status:'Paused'}];for(const binding of backend.bindings.filter(x=>x.segmentId===id&&x.campaignId===D))rows.push({id:D,name:binding.campaignName,status:'Unknown',missing:true});return rows.map(item=>{const owner=backend.bindings.find(x=>x.campaignId===item.id),own=owner?.segmentId===id;return {...item,selected:own,bindingId:own?owner.id:null,ownerSegmentId:owner?.segmentId||null,ownerSegmentName:owner?.segmentId==='segment-b'?'Segment B':null,selectable:!item.missing&&(!owner||own),available:!item.missing,removable:own,blockedReason:item.missing?'Рассылка удалена в Coldy':owner&&!own?'Уже связана с другим сегментом':''};});}
function service(id){return {id:'coldy',state:'partial',totals:{sent:100,replies:5,leads:null},campaigns:backend.bindings.filter(x=>x.segmentId===id).map(x=>({id:x.campaignId,name:x.campaignName,status:'Active',sent:x.campaignId===A?100:null,replies:5,leads:null})),generatedAt:'2026-11-22T09:00:00Z'};}
function infra(){const accounts=backend.infraSynced?Array.from({length:backend.infraContinued?6:5},(_,i)=>({id:'account-'+i,email:backend.accountMarker+i+'@example.test',name:'Sender '+i,provider:'SMTP',status:i===1?'error':'connected',sentTotal:i===0?100:null,sentToday:null,dailyLimit:40,errorCount:null,errors:i===1?[{code:'SMTP',message:'<img src=x onerror=alert(1)> disconnected'}]:[],tags:[],warmup:{status:null,sentToday:null,repliesToday:null},updatedAt:'2026-11-22T09:00:00Z',stale:false})):[];return {state:!backend.configured?'not_configured':!backend.infraSynced?'not_synced':backend.infraContinued?'ready':'partial',configured:backend.configured,connected:backend.connected,accounts,totals:{accounts:accounts.length,sentTotal:null,sentToday:null,dailyLimit:null,errorCount:null,accountsWithErrors:accounts.length?1:0},lastSyncAt:backend.infraSynced?backend.lastSyncAt:null,warnings:[],nextCursor:backend.infraSynced&&!backend.infraContinued?'continue-token-opaque':null,detailProgress:{completed:accounts.length,total:6}};}
function api(name,p){
 if(name==='getProjectAnalytics')return {state:backend.catalogState||'ready',segments:backend.catalogState?[]:[{id:'segment-a',name:'Segment A'},{id:'segment-b',name:'Segment B'}],coldy:{configured:backend.configured,connected:backend.connected,checkedAt:null}};
 if(name==='getProjectAnalyticsCampaigns')return {state:backend.configured?'ready':'not_configured',configured:backend.configured,connected:backend.connected,segment:{id:p.segmentId,name:p.segmentId==='segment-a'?'Segment A':'Segment B'},bindings:clone(backend.bindings.filter(x=>x.segmentId===p.segmentId)),campaigns:backend.configured?campaigns(p.segmentId):[],generatedAt:'2026-11-22T09:00:00Z',cached:true};
 if(name==='getSegmentMailings')return {services:[service(p.segmentId)]};
 if(name==='refreshColdyMailings')return service(p.segmentId);
 if(name==='saveColdyBinding'){if(backend.receipts[p.requestId])return clone(backend.receipts[p.requestId]);const existing=backend.bindings.find(x=>x.campaignId===p.campaignId);if(existing&&existing.segmentId!==p.segmentId)throw new Error('[COLDY_CAMPAIGN_BOUND] Bound elsewhere');if(existing&&p.preserveExisting)return backend.receipts[p.requestId]={binding:clone(existing)};const binding={...p,id:'binding-created-0000001',campaignName:'New campaign',revision:1};backend.bindings.push(binding);backend.saveMutations++;const result={binding};backend.receipts[p.requestId]=clone(result);if(backend.failAfterSave){backend.failAfterSave=false;throw new Error('[GOOGLE_ERROR] Ответ потерян');}return result;}
 if(name==='removeColdyBinding'){if(backend.receipts[p.requestId])return clone(backend.receipts[p.requestId]);backend.bindings=backend.bindings.filter(x=>x.id!==p.bindingId);return backend.receipts[p.requestId]={removed:true};}
 if(name==='getProjectInfrastructure'){if(backend.infraErrorDto)return {state:'error',configured:true,connected:true,accounts:[],totals:{accounts:null,sentTotal:null,sentToday:null,errorCount:null,accountsWithErrors:null},lastSyncAt:null,nextCursor:null,error:{code:'COLDY_HTTP',message:'Inventory unavailable'},syncPaused:true};const value=infra();if(backend.cacheStale)value.stale=true;return value;}
 if(name==='refreshProjectInfrastructure'){if(backend.failInfra)throw new Error('[COLDY_HTTP] API temporarily unavailable');backend.infraSynced=true;if(p.cursor&&!backend.sameCursor)backend.infraContinued=true;const value=infra();if(backend.pauseFirst)Object.assign(value,{syncPaused:true,retryAfterMs:15000,error:{code:'COLDY_RATE_LIMIT',message:'Rate limited'}});return value;}
 throw new Error('Unexpected RPC '+name);
}
window.transport=(name,p,guard)=>{
 if(guard&&!guard())return Promise.resolve(null);
 backend.calls.push({name,payload:clone(p)});backend.active++;const write=['saveColdyBinding','removeColdyBinding'].includes(name);if(write){backend.activeWrites++;backend.maxWrites=Math.max(backend.maxWrites,backend.activeWrites);}
 let value,error;try{value=clone(api(name,p));}catch(e){error=e;}
 return new Promise((resolve,reject)=>{const finish=()=>{backend.active--;if(write)backend.activeWrites--;if(error)reject(error);else resolve(value);};if(backend.holdMethods.includes(name))backend.pending.push({name,finish});else setTimeout(finish,8);});
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
for(const method of ['getProjectAnalytics','getProjectAnalyticsCampaigns','getSegmentMailings','refreshColdyMailings','saveColdyBinding','removeColdyBinding','getProjectInfrastructure','refreshProjectInfrastructure'])api[method]=payload=>projectApi(method,payload);
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
        browser = p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
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

        reset()
        expect(page.locator('#pj-segment')).to_be_enabled()
        page.locator('#pj-segment').select_option('segment-a');idle()
        expect(page.locator('[data-project-campaign="'+ '11111111-1111-4111-8111-111111111111' +'"]')).to_be_checked()
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

        reset();page.locator('#pj-segment').select_option('segment-a');idle()
        page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]').check()
        teammate=page.evaluate("(()=>{const binding={id:'teammate-binding-0000001',segmentId:'segment-a',campaignId:B,campaignName:'New campaign',includeCompanies:false,includeLpr:true,autoUpload:true,allowActive:true,revision:7};backend.bindings.push(binding);return JSON.parse(JSON.stringify(binding));})()")
        page.locator('#pj-selection-save').click();idle()
        assert page.evaluate('backend.bindings.find(x=>x.campaignId===B)')==teammate
        assert page.evaluate('backend.saveMutations')==0,'Concurrent same-segment binding retains every setting'

        # Refresh rebases explicit user changes instead of deleting a teammate's binding.
        for clean in [False,True]:
            reset();page.locator('#pj-segment').select_option('segment-a');idle()
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

        reset('infrastructure')
        assert count('refreshProjectInfrastructure')==2,'Finite pagination completes both batches'
        expect(page.locator('#pj-infrastructure-continue')).to_be_hidden()
        assert page.locator('#pj-account-rows tr').count()==6
        assert page.locator('#pj-account-rows img').count()==0
        assert '<img' in page.locator('#pj-account-rows').inner_text()
        assert page.locator('#pj-account-rows tr').first.locator('td').nth(3).inner_text()=='—'
        page.wait_for_timeout(350)
        assert count('refreshProjectInfrastructure')==2,'No provider polling loop after completion'
        calls=page.evaluate("backend.calls.filter(x=>x.name==='refreshProjectInfrastructure')")
        assert calls[-1]['payload']=={'cursor':'continue-token-opaque'}
        assert page.locator('#pj-account-rows tr').count()==6
        expect(page.locator('#pj-infrastructure-continue')).to_be_hidden()
        page.evaluate('backend.failInfra=true')
        page.locator('#pj-infrastructure-refresh').click();idle()
        assert page.locator('#pj-account-rows tr').count()==6,'Old safe values survive refresh failure'
        assert 'unavailable' in page.locator('#pj-infrastructure-health').inner_text()
        previous=count('refreshProjectInfrastructure');page.wait_for_timeout(350)
        assert count('refreshProjectInfrastructure')==previous

        reset('infrastructure',setup='backend.infraSynced=true;backend.cacheStale=true')
        assert count('refreshProjectInfrastructure')==2,'One stale-cache refresh completes the finite run'
        page.wait_for_timeout(350)
        assert count('refreshProjectInfrastructure')==2,'Stale marker cannot become a polling loop'
        reset('infrastructure',setup='backend.infraErrorDto=true')
        assert page.locator('#pj-infrastructure-totals dd').all_text_contents()==['—','—','—','—']
        assert 'Inventory unavailable' in page.locator('#pj-infrastructure-health').inner_text()
        for setup,expected_calls in [('backend.pauseFirst=true',1),('backend.sameCursor=true',2)]:
            reset('infrastructure',setup=setup)
            assert count('refreshProjectInfrastructure')==expected_calls
            page.wait_for_timeout(350)
            assert count('refreshProjectInfrastructure')==expected_calls,'Pause/cursor failure cannot spin'
            expect(page.locator('#pj-infrastructure-continue')).to_be_visible()

        # Leaving the view pauses the finite run; Continue resumes its exact cursor.
        page.goto('about:blank');page.set_content(HTML)
        page.evaluate("backend.holdMethods=['refreshProjectInfrastructure'];start('infrastructure')")
        page.wait_for_function("backend.pending.some(x=>x.name==='refreshProjectInfrastructure')")
        page.evaluate("RegistryProject.show('analytics',{ready:true,epoch:1});backend.holdMethods=[];release('refreshProjectInfrastructure')")
        page.wait_for_function('backend.active===0')
        assert count('refreshProjectInfrastructure')==1
        page.evaluate("RegistryProject.show('infrastructure',{ready:true,epoch:1});void RegistryProject.refresh({opening:true})")
        idle();expect(page.locator('#pj-infrastructure-continue')).to_be_visible()
        page.locator('#pj-infrastructure-continue').click();idle()
        assert count('refreshProjectInfrastructure')==2

        # Credential rotation stops a started finite sync before its next batch.
        page.goto('about:blank');page.set_content(HTML)
        page.evaluate("backend.holdMethods=['refreshProjectInfrastructure'];start('infrastructure')")
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
        page.evaluate("backend.infraSynced=true;backend.holdMethods=['getProjectInfrastructure'];backend.accountMarker='private-old';start('infrastructure')")
        page.wait_for_function("backend.pending.some(x=>x.name==='getProjectInfrastructure')")
        page.evaluate("RegistryProject.lock();backend.holdMethods=[];backend.accountMarker='new-scope';start('infrastructure',2)")
        page.wait_for_function("document.querySelector('#pj-account-rows')?.textContent.includes('new-scope')")
        page.evaluate("release('getProjectInfrastructure')");idle()
        assert 'private-old' not in page.locator('#pj-account-rows').inner_text()

        reset()
        page.locator('#pj-segment').select_option('segment-a');idle()
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
        page.locator('#br-view-analytics').click()
        expect(page.locator('#pj-analytics-view')).to_be_visible()
        expect(page.locator('#br-view-analytics')).to_have_attribute('aria-pressed','true')
        page.locator('#pj-segment').select_option('segment-a');idle()
        page.locator('#pj-analytics-connect').click()
        expect(page.locator('#br-coldy-dialog')).to_be_visible()
        page.wait_for_function('backend.active===0')
        page.locator('#br-coldy-close').click()
        page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]').check()
        assert page.evaluate('RegistryProject.isEditing()') is True
        before=count('getProjectAnalyticsCampaigns')
        page.locator('#br-view-infrastructure').click();idle()
        expect(page.locator('#pj-infrastructure-view')).to_be_visible()
        assert page.locator('#pj-account-rows tr').count()==6
        page.locator('#br-view-analytics').click();idle()
        expect(page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]')).to_be_checked()
        assert count('getProjectAnalyticsCampaigns')==before,'Warm opening preserves the unsaved chooser'
        page.locator('#br-refresh').click();idle()
        expect(page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]')).to_be_checked()
        expect(page.locator('#pj-selection-save')).to_be_enabled()
        page.locator('#pj-analytics-connect').click();idle()
        page.locator('#br-coldy-test').click();idle()
        page.locator('#br-coldy-close').click();idle()
        expect(page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]')).to_be_checked()
        page.locator('#pj-analytics-connect').click();idle()
        page.locator('#br-coldy-provider').select_option('coldy')
        page.locator('#br-coldy-save').click();idle()
        page.locator('#br-coldy-close').click();idle()
        expect(page.locator('[data-project-campaign="22222222-2222-4222-8222-222222222222"]')).to_be_checked()
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'),'Five-tab header must not overflow mobile viewport'
        assert not any(call['name'].startswith(('startColdy','startPhone','payValidation','startPromouser')) for call in page.evaluate('backend.calls'))
        page.evaluate('RegistryProject.invalidate({credentialsChanged:true})')
        assert page.locator('#pj-segment').input_value()==''
        assert not page.evaluate('RegistryProject.isEditing()')
        assert page.locator('#pj-account-rows').inner_text()==''
        assert not errors,errors
        browser.close()
        print('PASS: segment campaigns, delta-only stable retries, flags preserved, sender sync chunks, unknown metrics, stale responses and access scrubbing.')

if __name__=='__main__':
    main()
