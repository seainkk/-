/** Dedicated incoming-only timer. It never invokes upload, validation or mailing start operations. */
var COLDY_INCOMING = Object.freeze({handler:'coldyRecipientTick_',timer:'COLDY_RECIPIENT_TIMER_V1',
  lease:'COLDY_RECIPIENT_TICK_LEASE',budget:45000,leaseMillis:300000,writeBatch:300});

function coldyIncomingTimer_(properties) {
  try { return JSON.parse(properties.getProperty(COLDY_INCOMING.timer) || 'null'); } catch (error) { return null; }
}

function coldyIncomingEnsure_(context,explicit) {
  var properties=context.properties, now=Date.now(), verifier=SHARED_REQUEST_SCOPE_.keyHash;
  function current(marker) {return marker && marker.rootId===context.rootId && marker.verifier===verifier;}
  function result(enabled,needsOwnerSetup){return {enabled:enabled,needsOwnerSetup:needsOwnerSetup,intervalMinutes:1};}
  var marker=coldyIncomingTimer_(properties);
  if (!explicit && current(marker) && marker.checkedAt>now-300000) return result(!!marker.uid,!marker.uid);
  try {
    return locked_(function () {
      var fresh=authorize_(); registryRoot_(fresh);
      if(fresh.rootId!==context.rootId) fail_('SOURCE_CHANGED','Корневая папка изменилась.');
      var previous=coldyIncomingTimer_(properties);
      if (!explicit && current(previous) && previous.checkedAt>now-300000) return result(!!previous.uid,!previous.uid);
      var matches=ScriptApp.getProjectTriggers().filter(function (t){return t.getHandlerFunction()===COLDY_INCOMING.handler;});
      var timer=matches.find(function (t){return current(previous)&&t.getUniqueId()===previous.uid;}) ||
        matches[0] || ScriptApp.newTrigger(COLDY_INCOMING.handler).timeBased().everyMinutes(1).create();
      properties.setProperty(COLDY_INCOMING.timer,JSON.stringify({uid:timer.getUniqueId(),rootId:context.rootId,verifier:verifier,checkedAt:now}));
      // Any other legacy duplicate immediately fails the UID check, even if removal is unavailable.
      matches.forEach(function(t){if(t.getUniqueId()!==timer.getUniqueId()) try {ScriptApp.deleteTrigger(t);} catch(ignored){}});
      return result(true,false);
    },1000);
  } catch(error) {
    if (error.registryCode && error.registryCode!=='BUSY') throw error;
    if (error.registryCode==='BUSY') return result(!!(current(marker)&&marker.uid),false);
    var latest=coldyIncomingTimer_(properties);
    if(!current(latest)||!latest.uid) properties.setProperty(COLDY_INCOMING.timer,JSON.stringify({rootId:context.rootId,verifier:verifier,checkedAt:now,uid:null}));
    return result(false,true);
  }
}

function enableColdyRecipientSync_(request) {
  return api_(function(){
    coldyInput_(request||{},[]); var context=authorize_();
    if(!coldySettings_(context).configured) fail_('COLDY_KEY_REQUIRED','Сначала подключите Coldy.');
    return coldyIncomingEnsure_(context,true);
  });
}

function coldyIncomingOwner_(context,credential,project,binding) {
  return digest_(JSON.stringify([context.rootId,credential,project,binding.segmentId,binding.id,binding.campaignId]));
}

function coldyIncomingMark_(properties,owner){
  return JSON.parse(properties.getProperty('COLDY_INCOMING_'+owner)||'{}');
}

/** Attach status to already selected bindings only. Catalogue and grid opens do not enumerate campaigns. */
function coldyIncomingDecorate_(context,bindings,rows){
  if(!bindings.length) return;
  var timer=coldyIncomingEnsure_(context,false), credential=coldyCredentialHash_(context), project=registryProjectId_();
  var byId=new Map((rows||[]).map(function(row){return [row.id,row];}));
  bindings.forEach(function(b){
    var mark=coldyIncomingMark_(context.properties,coldyIncomingOwner_(context,credential,project,b));
    var status={enabled:timer.enabled,needsOwnerSetup:timer.needsOwnerSetup,state:timer.enabled?(mark.state||'waiting'):'off',
      lastSyncedAt:mark.lastSyncedAt||null,lastSuppressionAt:mark.lastSuppressionAt||null,suppressionPending:mark.suppressionPending===true,
      nextRetryAt:mark.retryAt>Date.now()?new Date(mark.retryAt).toISOString():null};
    b.recipientSync=status;
    if(byId.has(b.campaignId)) byId.get(b.campaignId).recipientSync=status;
  });
}

function coldyIncomingKinds_(context,project,binding){
  return ['companies','lpr'].filter(function(kind){
    if(kind==='companies'?binding.includeCompanies:binding.includeLpr) return true;
    // Older manual imports remember the exact binding and target even if the outbound checkbox is off.
    var slot=digest_(JSON.stringify([context.rootId,project,binding.segmentId,binding.id,kind]));
    var jobKey=context.properties.getProperty('COLDY_RECIPIENT_SLOT_'+slot);
    if(!jobKey) return false;
    var job=JSON.parse(context.properties.getProperty(jobKey)||'null');
    var fingerprint=digest_(JSON.stringify([context.rootId,project,binding.segmentId,binding.id,binding.campaignId,kind,coldyCredentialHash_(context)]));
    if(!job || job.state!=='complete' || job.fingerprint!==fingerprint || !job.target) return false;
    var target=coldyRecipientSheetTarget_(context,binding,kind);
    return target.fileId===job.target.fileId && target.sheetId===job.target.sheetId;
  });
}

function coldyIncomingStep_(context,job,guard,deadline){
  var b=job.b, mark=job.mark;
  var state=coldyLoad_(context,'recipientpoll',job.owner)||{};
  if(state.bindingRevision!==b.revision) state={bindingRevision:b.revision};
  function save(){locked_(function(){guard();coldySave_(context,'recipientpoll',job.owner,state);});}
  var scan=state.scan, hadCheckpoint=!!scan;
  // Both activities keep independent cursors. A long blacklist lookup cannot hold up fresh lead events.
  if(!scan) state.scan=scan={phase:'read',offset:0,total:null,rows:[]};
  var staged=scan.phase==='write';
  if(scan.phase==='read'){
    try {
      var first=scan.total===null;
      coldyIncomingRead_(context,b,scan,guard);
      if(first && scan.offset<scan.total && Date.now()<deadline-5000) coldyIncomingRead_(context,b,scan,guard);
    }
    catch(error){
      if(error.registryCode==='COLDY_RECIPIENT_LIST_CHANGED'){
        delete state.scan;save();
      }
      throw error;
    }
    if(scan.offset===scan.total){
      var groups=new Map();
      scan.rows.forEach(function(lead){
        if(!groups.has(lead.email)) groups.set(lead.email,[]);
        groups.get(lead.email).push(lead);
      });
      scan.rows=Array.from(groups.values(),coldyRecipientMerge_);
      var historic=coldyRecipientHistoricalBlocks_(context,b,scan.rows);
      scan.rows=scan.rows.concat(historic).sort(function(a,b){return a.email.localeCompare(b.email);});
      var emails=scan.rows.map(function(row){return row.email;});
      var identity=digest_(JSON.stringify(emails));
      if(!state.policy||state.policy.identity!==identity){
        var allowed=new Set(emails);
        state.policy={identity:identity,emails:emails,known:(state.policy&&state.policy.known||[]).filter(function(e){return allowed.has(e);}),hits:[],cursor:null};
        mark.lastSuppressionAt=null;
      }
      mark.suppressionPending=!!emails.length && (!state.policy.checkedAt || Date.now()-state.policy.checkedAt>=300000);
      scan.kinds=coldyIncomingKinds_(context,job.project,b);
      scan.targets={};scan.unavailable=false;
      scan.kinds.forEach(function(kind){
        try{scan.targets[kind]=coldyRecipientSheetTarget_(guard(),b,kind);}
        catch(error){
          if(['COLDY_TARGETS_REQUIRED','COLDY_TARGET_CHANGED','SEGMENT_TARGETS_REQUIRED','NOT_FOUND'].indexOf(error.registryCode)<0) throw error;
          scan.unavailable=true;
        }
      });
      scan.phase='write';scan.targetIndex=0;scan.position=0;
    }
    if(scan.phase==='read') save();
  }
  if(scan.phase==='write'){
    var blocked=new Set((state.policy.known||[]).concat(state.policy.hits||[]));
    var rows=scan.rows.map(function(row){
      if(row.blacklisted||blocked.has(row.email)) return Object.assign({},row,{blacklisted:true});
      return state.policy.checkedAt?Object.assign({},row,{blacklisted:false}):row;
    });
    var fingerprint=digest_(JSON.stringify([scan.campaignStatus,scan.campaignName,rows]));
    if(scan.fingerprint && scan.fingerprint!==fingerprint){scan.targetIndex=0;scan.position=0;delete scan.startVersion;}
    scan.fingerprint=fingerprint;
    state.checked=state.checked||{};
    while(scan.targetIndex<scan.kinds.length && Date.now()<deadline){
      var kind=scan.kinds[scan.targetIndex];
      var target=scan.targets[kind], prior=state.checked[kind];
      if(!target){scan.targetIndex++;continue;}
      var observed=coldyRecipientSheetVersion_(guard(),b,kind,target,contactSyncMetadata_(target.fileId));
      if(prior && prior.version===observed && prior.fingerprint===fingerprint && prior.fileId===target.fileId && prior.sheetId===target.sheetId){
        scan.targetIndex++;scan.position=0;delete scan.startVersion;continue;
      }
      if(!scan.startVersion) scan.startVersion=observed;
      var batch=rows.slice(scan.position,scan.position+COLDY_INCOMING.writeBatch);
      var binding=Object.assign({},b,{campaignName:scan.campaignName,campaignStatus:scan.campaignStatus});
      // Persist the proven snapshot before the first uncertain external write. A retry is idempotent.
      if(!staged){save();staged=true;}
      if(batch.length) coldyRecipientSheetWrite_(context,binding,kind,target,batch,guard,null,{existingOnly:true});
      scan.position+=batch.length;
      if(scan.position>=rows.length){
        var after=coldyRecipientSheetVersion_(guard(),b,kind,target,contactSyncMetadata_(target.fileId));
        // If the sheet changed while reconciling, ask for one clean pass before allowing a range-read skip.
        if(after===scan.startVersion) state.checked[kind]={fileId:target.fileId,sheetId:target.sheetId,version:after,fingerprint:fingerprint};
        else delete state.checked[kind];
        scan.targetIndex++;scan.position=0;delete scan.startVersion;
      } else save();
    }
    if(scan.targetIndex===scan.kinds.length){
      delete state.scan;
      if(!scan.kinds.length) mark.state='waiting';
      else if(scan.unavailable) mark.state='error';
      else {mark.lastSyncedAt=new Date().toISOString();mark.state='synced';}
      // On an unchanged cycle neither the private snapshot nor any sheet needs to be rewritten.
      if(staged || hadCheckpoint || state.lastIdentity!==fingerprint){state.lastIdentity=fingerprint;save();}
    } else {mark.state='syncing';save();}
  } else mark.state='syncing';
  if(Date.now()>=deadline||!state.policy||!state.policy.emails.length) return;
  var policy=state.policy;
  if(policy.checkedAt && Date.now()-policy.checkedAt<300000 || policy.retryAt>Date.now()) return;
  var result=coldyRecipientSuppression_(context,policy.emails.map(function(email){return {email:email};}),guard,policy.cursor);
  policy.hits=Array.from(new Set(policy.hits.concat(result.hits)));
  policy.cursor=result.nextCursor;policy.retryAt=result.retryAfterMs?Date.now()+result.retryAfterMs:0;
  if(!policy.cursor && !result.unavailable && !policy.retryAt){
    policy.known=policy.hits;policy.hits=[];policy.checkedAt=Date.now();
    mark.lastSuppressionAt=new Date(policy.checkedAt).toISOString();mark.suppressionPending=false;
  } else if(result.unavailable) policy.retryAt=Date.now()+300000;
  save();
  if(result.retryAfterMs){
    var throttled=registryError_('COLDY_RATE_LIMIT','Coldy попросил отложить сверку.');
    throttled.retryAfterMs=result.retryAfterMs;throw throttled;
  }
}

/** One bounded batch per campaign. Validate the full membership before publishing duplicate-email totals. */
function coldyIncomingRead_(context,b,scan,guard){
  var id=coldyCampaignId_(b.campaignId), offsets=[scan.offset];
  for(var next=scan.offset+200;scan.total!==null && next<scan.total && offsets.length<4;next+=200) offsets.push(next);
  var paths=offsets.map(function(o){return '/leads/campaign/'+id+'?limit=200&offset='+o;});
  var initial=scan.total===null;
  if(initial) paths.unshift('/campaigns/'+id);
  var responses=coldyGetBatch_(context,paths,guard);
  var failure=responses.find(function(r){return r.error&&r.error.registryCode==='COLDY_RATE_LIMIT';})||responses.find(function(r){return r.error;});
  if(failure) throw failure.error;
  if(initial){
    var detail=coldyCampaignDetail_(id,responses.shift().value);
    scan.campaignStatus=detail.status;scan.campaignName=detail.name;
  }
  var seen=new Set(scan.rows.map(function(lead){return lead.id;}));
  offsets.forEach(function(offset,index){
    var page=coldyRecipientNormalizePage_(id,offset,responses[index].value);
    if(scan.total!==null&&page.total!==scan.total) fail_('COLDY_RECIPIENT_LIST_CHANGED','Изменился состав получателей.');
    scan.total=page.total;
    page.items.forEach(function(row){
      if(seen.has(row.id)) fail_('COLDY_RECIPIENT_LIST_CHANGED','Coldy повторил адресата между страницами.');
      seen.add(row.id);
      // Names, message text and personalization are unnecessary in an incoming status update.
      scan.rows.push({id:row.id,email:row.email,status:row.status,sentCount:row.sentCount,replied:row.replied,bounced:row.bounced,doNotSend:row.doNotSend});
    });
    scan.offset+=page.items.length;
  });
}

function coldyRecipientTick_(event){
  var props=PropertiesService.getScriptProperties(), timer=coldyIncomingTimer_(props);
  if(!timer||!timer.uid||!event||event.triggerUid!==timer.uid||timer.verifier!==sharedConfiguredHash_(props)||
    timer.rootId!==(props.getProperty('ROOT_FOLDER_ID')||REGISTRY_CONFIG.defaultRootFolderId)) return;
  var previous=SHARED_REQUEST_SCOPE_, claim=Utilities.getUuid(), started=Date.now(), acquired=false;
  SHARED_REQUEST_SCOPE_={keyHash:timer.verifier,automation:true};
  function timerGuard(){
    var current=authorize_(), marker=coldyIncomingTimer_(props), lease=JSON.parse(props.getProperty(COLDY_INCOMING.lease)||'null');
    if(current.rootId!==timer.rootId||!marker||marker.uid!==timer.uid||marker.verifier!==timer.verifier||
       !lease||lease.id!==claim||lease.until<=Date.now()) fail_('COLDY_SCOPE_CHANGED','Изменились параметры фоновой сверки.');
    return current;
  }
  try {
    acquired=locked_(function(){
      var old=JSON.parse(props.getProperty(COLDY_INCOMING.lease)||'null');
      if(old && old.until>started) return false;
      props.setProperty(COLDY_INCOMING.lease,JSON.stringify({id:claim,until:started+COLDY_INCOMING.leaseMillis}));return true;
    },300);
    if(!acquired) return;
    var context=timerGuard(), settings=coldySettings_(context);
    if(!settings.configured) return;
    var credential=settings.credentialHash, pauseKey='COLDY_INCOMING_PAUSE_'+digest_(context.rootId+'|'+credential);
    if(Number(props.getProperty(pauseKey))>Date.now()) return;
    var bindings=coldyCampaignRegistry_(context).bindings, snapshot=props.getProperties(), jobs=[];
    bindings.forEach(function(b){
      var project=registrySegmentProject_(context,b.segmentId,snapshot); if(!registryProjectName_(project)) return;
      var owner=coldyIncomingOwner_(context,credential,project,b), mark=coldyIncomingMark_(props,owner);
      if(!(mark.retryAt>Date.now())) jobs.push({project:project,b:b,owner:owner,mark:mark});
    });
    jobs.sort(function(a,b){return (a.mark.attempt||0)-(b.mark.attempt||0)||a.owner.localeCompare(b.owner);});
    for(var i=0;i<jobs.length && Date.now()-started<COLDY_INCOMING.budget;i++){
      var job=jobs[i], b=job.b, mark=job.mark, observations={};
      SHARED_REQUEST_SCOPE_.projectId=job.project;
      function guard(){
        var fresh=timerGuard();
        if(coldyCredentialHash_(fresh)!==credential||registrySegmentProject_(fresh,b.segmentId)!==job.project)
          fail_('COLDY_SCOPE_CHANGED','Изменились проект или подключение.');
        coldyCampaignScope_(fresh,b.segmentId,true);
        if(!observations.registry||!observations.unchanged||!observations.unchanged()){
          delete observations.unchanged;
          observations.registry=coldyCampaignRegistry_(fresh,observations);
        }
        var current=coldyCampaignBinding_(observations.registry,b.segmentId,b.id);
        if(current.campaignId!==b.campaignId||current.revision!==b.revision) fail_('COLDY_BINDING_CHANGED','Изменились настройки привязки.');
        return fresh;
      }
      try {
        guard(); mark.retryAt=0; mark.attempt=Date.now();
        coldyIncomingStep_(context,job,guard,started+COLDY_INCOMING.budget);
      } catch(error) {
        if(error.registryCode==='LINK_ACCESS_REQUIRED'||error.registryCode==='LINK_SETUP_REQUIRED') throw error;
        var retry=Number(error.retryAfterMs)||0;
        mark.state='error';mark.retryAt=Date.now()+Math.max(60000,retry,error.registryCode==='COLDY_NOT_FOUND'?900000:0);
        if(error.registryCode==='COLDY_RATE_LIMIT') props.setProperty(pauseKey,String(mark.retryAt));
      }
      timerGuard();props.setProperty('COLDY_INCOMING_'+job.owner,JSON.stringify(mark));
      if(Number(props.getProperty(pauseKey))>Date.now()) break;
    }
  } finally {
    try {if(acquired) locked_(function(){
      var current=JSON.parse(props.getProperty(COLDY_INCOMING.lease)||'null');
      if(current&&current.id===claim) props.deleteProperty(COLDY_INCOMING.lease);
    },1000);} finally {SHARED_REQUEST_SCOPE_=previous;}
  }
}
