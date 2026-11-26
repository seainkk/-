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

function coldyIncomingMark_(properties,owner,revision){
  var mark=JSON.parse(properties.getProperty('COLDY_INCOMING_'+owner)||'{}');
  var savedRevision=mark.bindingRevision==null?mark.progressRevision:mark.bindingRevision;
  return savedRevision!=null && savedRevision!==revision?{}:mark;
}

function coldyIncomingHeartbeatKey_(marker){
  return 'COLDY_INCOMING_CLOCK_'+digest_(JSON.stringify([marker.uid,marker.rootId,marker.verifier]));
}

// Expose a fixed reason only. Provider messages can contain addresses or credentials.
function coldyIncomingIssue_(error){
  var code=error && error.registryCode;
  if(code==='COLDY_RATE_LIMIT')return 'rate_limit';
  if(['COLDY_AUTH','COLDY_FORBIDDEN','COLDY_KEY_REQUIRED'].includes(code))return 'connection';
  if(['COLDY_NETWORK','COLDY_PROVIDER','COLDY_UNAVAILABLE','COLDY_CONFLICT','COLDY_RESPONSE','COLDY_NOT_FOUND'].includes(code))return 'provider';
  if(code==='COLDY_RECIPIENT_LIST_CHANGED')return 'membership_changed';
  if(['COLDY_TARGET_CHANGED','COLDY_TARGETS_REQUIRED','SEGMENT_TARGETS_REQUIRED','SEGMENT_MASTER_CHANGED',
      'CONTACT_SYNC_NOT_ENROLLED','GRID_SHEET_MISSING','NOT_FOUND'].includes(code))return 'target';
  if(['COLDY_STORAGE','COLDY_STORAGE_UNCERTAIN','COLDY_STORAGE_LIMIT','PROJECT_STORAGE','CONTACT_STORAGE_MISSING',
      'CONTACT_STORAGE_UNCERTAIN','CONTACT_STORAGE_DAMAGED'].includes(code))return 'storage';
  if(['OUTSIDE_REGISTRY','OUTSIDE_PROJECT','COLDY_SCOPE_CHANGED','COLDY_BINDING_CHANGED','COLDY_CREDENTIAL_CHANGED'].includes(code))return 'scope';
  if(code==='CONTACT_SYNC_JOB_ACTIVE')return 'contact_job';
  if(code==='BUSY'||code==='CONTACT_SYNC_LEASE_LOST')return 'busy';
  if(code==='COLDY_RECIPIENT_LEASE_EXPIRED')return 'timeout';
  if(code==='CONFLICT')return 'sheet_changed';
  if(code==='COLDY_SCHEMA'||code==='CONTACT_SCHEMA_CHANGED')return 'sheet_schema';
  if(code==='GRID_READ_ONLY'||code==='DRIVE_AUTH_REQUIRED')return 'google_access';
  if(code==='DRIVE_SETUP_REQUIRED')return 'google_setup';
  if(code==='GRID_ACCESS_UNAVAILABLE')return 'google_unavailable';
  if(!code||code==='SHEETS_RAW_UNCERTAIN'){
    var reason=code ? error.sheetRawDiagnostic||'' : sheetRawServiceReason_(error);
    if(/RATE_LIMITED$/.test(reason))return 'google_quota';
    if(/GOOGLE_UNAVAILABLE$/.test(reason))return 'google_unavailable';
    if(/SERVICE_DISABLED$|ADVANCED_SERVICE_UNAVAILABLE$/.test(reason))return 'google_setup';
    if(/INSUFFICIENT_SCOPES$|PERMISSION_DENIED$|AUTH_REQUIRED$/.test(reason))return 'google_access';
    if(/NOT_FOUND$/.test(reason))return 'target';
    if(code && /GRID_BOUNDS$/.test(reason))return 'sheet_schema';
    if(code && /INVALID_FIELD_MASK$|INVALID_ARGUMENT$/.test(reason))return 'sheet_rejected';
    if(code)return 'sheet_unconfirmed';
    // Native Apps Script exceptions often carry no structured Google error fields.
    var message=String(error&&error.message||'').slice(0,4096);
    if(/exceeded maximum execution time/i.test(message))return 'timeout';
  }
  return 'unknown';
}

function coldyIncomingRetrying_(issue,code){
  return ['rate_limit','busy','contact_job','timeout','sheet_changed','membership_changed',
    'google_quota','google_unavailable','sheet_unconfirmed'].includes(issue) ||
    ['COLDY_NETWORK','COLDY_UNAVAILABLE','COLDY_CONFLICT'].includes(code);
}

// Mirror only confirmed cursors. The private scan itself contains email addresses and lead records.
function coldyIncomingProgress_(scan){
  if(!scan)return null;
  if(scan.phase==='read' && Number.isSafeInteger(scan.total))
    return {phase:'read',read:scan.offset,total:scan.total};
  if(scan.phase!=='write')return null;
  var kind=scan.kinds[scan.targetIndex];
  if(kind!=='companies'&&kind!=='lpr')return null;
  return {phase:'write',kind:kind,total:scan.rows.length,checked:scan.position,
    matched:scan.position===0?0:Number.isSafeInteger(scan.matched)?scan.matched:null};
}

/** Attach status to already selected bindings only. Catalogue and grid opens do not enumerate campaigns. */
function coldyIncomingDecorate_(context,bindings,rows){
  if(!bindings.length) return;
  var timer=coldyIncomingEnsure_(context,false), credential=coldyCredentialHash_(context), project=registryProjectId_();
  var marker=coldyIncomingTimer_(context.properties),clock={};
  if(timer.enabled&&marker&&marker.uid){
    clock=JSON.parse(context.properties.getProperty(coldyIncomingHeartbeatKey_(marker))||'{}');
  }
  var byId=new Map((rows||[]).map(function(row){return [row.id,row];}));
  bindings.forEach(function(b){
    var mark=coldyIncomingMark_(context.properties,coldyIncomingOwner_(context,credential,project,b),b.revision);
    var state=mark.state||'waiting',retryAt=Math.max(mark.retryAt||0,clock.retryAt||0);
    var clockIssue=clock.retryAt && clock.retryAt<=Date.now()?null:clock.issue;
    if(state==='syncing' && mark.attempt+COLDY_INCOMING.leaseMillis<Date.now())state='retrying';
    var status={enabled:timer.enabled,needsOwnerSetup:timer.needsOwnerSetup,state:timer.enabled?state:'off',
      lastSyncedAt:mark.lastSyncedAt||null,lastSuppressionAt:mark.lastSuppressionAt||null,suppressionPending:mark.suppressionPending===true,
      lastTickAt:clock.at||null,lastAttemptAt:mark.attempt?new Date(mark.attempt).toISOString():null,
      progress:timer.enabled&&mark.progressRevision===b.revision?mark.progress||null:null,
      issue:mark.issue||clockIssue||null,nextRetryAt:retryAt>Date.now()?new Date(retryAt).toISOString():null};
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

function coldyIncomingStep_(context,job,guard,deadline,writeCheckpoint){
  var b=job.b, mark=job.mark;
  var state=writeCheckpoint||coldyLoad_(context,'recipientpoll',job.owner)||{};
  if(writeCheckpoint && (state.bindingRevision!==b.revision || !state.scan || state.scan.phase!=='write')) return;
  if(state.bindingRevision!==b.revision) state={bindingRevision:b.revision};
  function updateProgress(){
    var progress=coldyIncomingProgress_(state.scan);
    if((!mark.progress&&!progress) || mark.progressRevision===b.revision && JSON.stringify(progress)===JSON.stringify(mark.progress))return false;
    mark.progress=progress;mark.progressRevision=b.revision;
    return true;
  }
  function save(){
    locked_(function(){
      guard();coldySave_(context,'recipientpoll',job.owner,state);
      if(updateProgress())context.properties.setProperty('COLDY_INCOMING_'+job.owner,JSON.stringify(mark));
    });
  }
  updateProgress();
  var scan=state.scan, hadCheckpoint=!!scan;
  // Both activities keep independent cursors. A long blacklist lookup cannot hold up fresh lead events.
  if(!scan) state.scan=scan={phase:'read',offset:0,total:null,rows:[]};
  var staged=scan.phase==='write';
  if(scan.phase==='read'){
    var startOffset=scan.offset, hadDetails=!!scan.campaignStatus, wasLimited=!!scan.singlePage;
    try {
      var first=scan.total===null && !wasLimited;
      coldyIncomingRead_(context,b,scan,guard);
      if(first && scan.offset<scan.total && Date.now()<deadline-5000) coldyIncomingRead_(context,b,scan,guard);
    }
    catch(error){
      if(error.registryCode==='COLDY_RECIPIENT_LIST_CHANGED' || error.registryCode==='COLDY_RESPONSE'){
        if(hadCheckpoint){delete state.scan;save();}
      } else if(coldyIncomingTransientRead_(error)){
        if(error.registryCode==='COLDY_RATE_LIMIT') scan.singlePage=true;
        if(startOffset!==scan.offset || hadDetails!==!!scan.campaignStatus || wasLimited!==!!scan.singlePage) save();
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
    if(scan.fingerprint && scan.fingerprint!==fingerprint){scan.targetIndex=0;scan.position=0;delete scan.startVersion;delete scan.wroteChanges;}
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
      if(batch.length){
        var before=scan.position===0?0:scan.matched;
        var receipt=coldyRecipientSheetWrite_(context,binding,kind,target,batch,guard,null,{existingOnly:true});
        if(!receipt.unchangedVersion){
          scan.wroteChanges=true;
          if(typeof segmentCardMaintenanceRequest_==='function') segmentCardMaintenanceRequest_(context,b.segmentId);
        }
        // A partial checkpoint created before matched counts existed can only report how many were checked.
        scan.matched=Number.isSafeInteger(before)&&Number.isSafeInteger(receipt.existing)?before+receipt.existing:null;
      }
      scan.position+=batch.length;
      if(scan.position>=rows.length){
        // The sheet writer verified this precise version under its lease for a no-op batch.
        // A changed sheet must get a clean pass before subsequent cycles can skip its ranges.
        var confirmed=batch.length?receipt.unchangedVersion:observed;
        if(!scan.wroteChanges && confirmed===scan.startVersion) state.checked[kind]={fileId:target.fileId,sheetId:target.sheetId,version:confirmed,fingerprint:fingerprint};
        else delete state.checked[kind];
        scan.targetIndex++;scan.position=0;delete scan.startVersion;delete scan.wroteChanges;
        if(scan.targetIndex<scan.kinds.length && Date.now()<deadline)save();
      } else save();
    }
    if(scan.targetIndex===scan.kinds.length){
      delete state.scan;
      // On an unchanged cycle neither the private snapshot nor any sheet needs to be rewritten.
      if(staged || hadCheckpoint || state.lastIdentity!==fingerprint){state.lastIdentity=fingerprint;save();}
      if(!scan.kinds.length) mark.state='no_target';
      else if(scan.unavailable){mark.state='error';mark.issue='target';}
      else {mark.lastSyncedAt=new Date().toISOString();mark.state='synced';}
    } else {mark.state='syncing';save();}
  } else mark.state='syncing';
  if(writeCheckpoint||Date.now()>=deadline||!state.policy||!state.policy.emails.length) return;
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

function coldyIncomingTransientRead_(error){
  return ['COLDY_RATE_LIMIT','COLDY_NETWORK','COLDY_UNAVAILABLE','COLDY_CONFLICT'].includes(error.registryCode);
}

/** One bounded batch per campaign. Validate the full membership before publishing duplicate-email totals. */
function coldyIncomingRead_(context,b,scan,guard){
  var id=coldyCampaignId_(b.campaignId), needDetails=scan.total===null && !scan.campaignStatus;
  var offsets=scan.singlePage && needDetails ? [] : [scan.offset];
  for(var next=scan.offset+200;!scan.singlePage && scan.total!==null && next<scan.total && offsets.length<4;next+=200) offsets.push(next);
  var paths=offsets.map(function(o){return '/leads/campaign/'+id+'?limit=200&offset='+o;});
  if(needDetails) paths.unshift('/campaigns/'+id);
  var responses=coldyGetBatch_(context,paths,guard);
  if(!Array.isArray(responses)||responses.length!==paths.length) fail_('COLDY_RESPONSE','Coldy не подтвердил все запрошенные страницы.');
  var errors=responses.filter(function(r){return r.error;}).map(function(r){return r.error;});
  var rateLimit=errors.filter(function(e){return e.registryCode==='COLDY_RATE_LIMIT';})
    .sort(function(a,b){return (b.retryAfterMs||0)-(a.retryAfterMs||0);})[0];
  try{
    var permanent=errors.find(function(e){return !coldyIncomingTransientRead_(e);});
    if(permanent) throw permanent;
    coldyIncomingApplyPages_(id,scan,offsets,responses,needDetails);
  }catch(error){
    if(rateLimit){
      error.coldyReadLimited=true;
      error.retryAfterMs=Math.max(error.retryAfterMs||0,rateLimit.retryAfterMs||0);
    }
    throw error;
  }
  if(errors.length) throw rateLimit||errors[0];
  if(offsets.length) delete scan.singlePage;
}

function coldyIncomingApplyPages_(id,scan,offsets,responses,needDetails){
  var contiguous=true;
  if(needDetails){
    var response=responses.shift();
    if(response.error) contiguous=false;
    else{
      var detail=coldyCampaignDetail_(id,response.value);
      scan.campaignStatus=detail.status;scan.campaignName=detail.name;
    }
  }
  var seen=new Set(scan.rows.map(function(lead){return lead.id;}));
  offsets.forEach(function(offset,index){
    if(responses[index].error){contiguous=false;return;}
    var page=coldyRecipientNormalizePage_(id,offset,responses[index].value);
    if(scan.total!==null&&page.total!==scan.total) fail_('COLDY_RECIPIENT_LIST_CHANGED','Изменился состав получателей.');
    page.items.forEach(function(row){
      if(seen.has(row.id)) fail_('COLDY_RECIPIENT_LIST_CHANGED','Coldy повторил адресата между страницами.');
      seen.add(row.id);
      // Names, message text and personalization are unnecessary in an incoming status update.
      if(contiguous) scan.rows.push({id:row.id,email:row.email,status:row.status,sentCount:row.sentCount,replied:row.replied,bounced:row.bounced,doNotSend:row.doNotSend});
    });
    if(contiguous){scan.total=page.total;scan.offset+=page.items.length;}
  });
}

// Installable triggers run as their creator. Only the lease property is touched under this owner lock.
function coldyIncomingLeaseLock_(operation){
  var lock=LockService.getUserLock();
  if(!lock.tryLock(1500))fail_('BUSY','Фоновая сверка ожидает освобождения очереди.');
  try{return operation();}finally{lock.releaseLock();}
}

function coldyRecipientTick_(event){
  var props=PropertiesService.getScriptProperties(), timer=coldyIncomingTimer_(props);
  if(!timer||!timer.uid||!event||event.triggerUid!==timer.uid||timer.verifier!==sharedConfiguredHash_(props)||
    timer.rootId!==(props.getProperty('ROOT_FOLDER_ID')||REGISTRY_CONFIG.defaultRootFolderId)) return;
  var previous=SHARED_REQUEST_SCOPE_, claim=Utilities.getUuid(), started=Date.now(), acquired=false,admitted=false,leaseUntil=0;
  var heartbeatKey=coldyIncomingHeartbeatKey_(timer), at=new Date(started).toISOString();
  function heartbeat(issue,retryAt){props.setProperty(heartbeatKey,JSON.stringify({at:at,issue:issue||null,retryAt:retryAt||0}));}
  SHARED_REQUEST_SCOPE_={keyHash:timer.verifier,automation:true};
  function authorizedTimer(){
    var current=authorize_(), marker=coldyIncomingTimer_(props);
    if(current.rootId!==timer.rootId||!marker||marker.rootId!==timer.rootId||marker.uid!==event.triggerUid||marker.verifier!==timer.verifier)
      fail_('COLDY_SCOPE_CHANGED','Изменились параметры фоновой сверки.');
    return current;
  }
  function timerGuard(){
    var current=authorizedTimer(),lease=JSON.parse(props.getProperty(COLDY_INCOMING.lease)||'null');
    if(!lease||lease.id!==claim||lease.until<=Date.now())fail_('COLDY_RECIPIENT_LEASE_EXPIRED','Истекло время текущей попытки сверки.');
    return current;
  }
  try {
    heartbeat();
    acquired=coldyIncomingLeaseLock_(function(){
      authorizedTimer();admitted=true;
      var now=Date.now(),old=JSON.parse(props.getProperty(COLDY_INCOMING.lease)||'null');
      if(old && old.until>now) return false;
      leaseUntil=now+COLDY_INCOMING.leaseMillis;
      props.setProperty(COLDY_INCOMING.lease,JSON.stringify({id:claim,until:leaseUntil}));return true;
    });
    if(!acquired) return;
    var context=timerGuard(), settings=coldySettings_(context);
    if(!settings.configured) return;
    var credential=settings.credentialHash, pauseKey='COLDY_INCOMING_PAUSE_'+digest_(context.rootId+'|'+credential);
    var sharedPause=coldyGetPause_(context,settings);
    var pausedUntil=Math.max(Number(props.getProperty(pauseKey))||0,sharedPause?Date.now()+sharedPause.retryAfterMs:0);
    var localOnly=pausedUntil>Date.now(), snapshot=props.getProperties(), readyOwners=null;
    if(localOnly){
      heartbeat('rate_limit',pausedUntil);
      // Public progress is only a discovery hint. The scoped private checkpoint is checked again before using it.
      readyOwners=new Set();
      Object.keys(snapshot).forEach(function(key){
        var match=/^COLDY_INCOMING_([A-Za-z0-9_-]{43})$/.exec(key);
        if(!match) return;
        var hint;
        try{hint=JSON.parse(snapshot[key]);}catch(invalid){return;}
        if(hint && hint.progress && hint.progress.phase==='write' && (!(hint.retryAt>Date.now())||hint.issue==='rate_limit'))
          readyOwners.add(match[1]);
      });
      if(!readyOwners.size) return;
    }
    var bindings=coldyCampaignRegistry_(context).bindings, jobs=[];
    bindings.forEach(function(b){
      var project=registrySegmentProject_(context,b.segmentId,snapshot); if(!registryProjectName_(project)) return;
      var owner=coldyIncomingOwner_(context,credential,project,b);
      if(localOnly && !readyOwners.has(owner)) return;
      var mark=coldyIncomingMark_(props,owner,b.revision);
      if(localOnly && (mark.progressRevision!==b.revision || !mark.progress || mark.progress.phase!=='write')) return;
      if(!(mark.retryAt>Date.now()) || localOnly && mark.issue==='rate_limit') jobs.push({project:project,b:b,owner:owner,mark:mark});
    });
    jobs.sort(function(a,b){return (a.mark.attempt||0)-(b.mark.attempt||0)||a.owner.localeCompare(b.owner);});
    // A slow Drive registry read must not consume every campaign's work window on every tick.
    var deadline=Math.min(Date.now()+COLDY_INCOMING.budget,leaseUntil-30000);
    for(var i=0;i<jobs.length && Date.now()<deadline;i++){
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
        timerGuard();
        var checkpoint=null;
        if(localOnly){
          checkpoint=coldyLoad_(guard(),'recipientpoll',job.owner);
          if(!checkpoint || checkpoint.bindingRevision!==b.revision || !checkpoint.scan || checkpoint.scan.phase!=='write') continue;
          guard();
        }
        mark.retryAt=0;mark.issue=null;mark.state='syncing';mark.attempt=Date.now();mark.bindingRevision=b.revision;
        // A hard Apps Script timeout cannot run finally. Persist the fair-queue position before remote calls.
        props.setProperty('COLDY_INCOMING_'+job.owner,JSON.stringify(mark));
        guard();
        coldyIncomingStep_(context,job,guard,deadline,checkpoint);
      } catch(error) {
        if(error.registryCode==='LINK_ACCESS_REQUIRED'||error.registryCode==='LINK_SETUP_REQUIRED') throw error;
        var retry=Number(error.retryAfterMs)||0;
        mark.issue=coldyIncomingIssue_(error);
        mark.state=coldyIncomingRetrying_(mark.issue,error.registryCode)?'retrying':'error';
        mark.retryAt=Date.now()+Math.max(60000,retry,error.registryCode==='COLDY_NOT_FOUND'?900000:0,mark.issue==='google_quota'?300000:0);
        if(error.registryCode==='COLDY_RATE_LIMIT'||error.coldyReadLimited){
          var pauseUntil=Date.now()+Math.max(60000,retry);
          props.setProperty(pauseKey,String(pauseUntil));heartbeat('rate_limit',pauseUntil);
        }
      }
      timerGuard();props.setProperty('COLDY_INCOMING_'+job.owner,JSON.stringify(mark));
      if(!localOnly && Number(props.getProperty(pauseKey))>Date.now()) break;
    }
  } catch(error) {
    heartbeat(coldyIncomingIssue_(error));throw error;
  } finally {
    try {
      if(acquired) {
        coldyIncomingLeaseLock_(function(){
          var current=JSON.parse(props.getProperty(COLDY_INCOMING.lease)||'null');
          if(current&&current.id===claim) props.deleteProperty(COLDY_INCOMING.lease);
        });
      }
      // A subsequent tick can build a card while the previous Coldy poll finishes.
      // Direct sheet edits remain eligible when the provider is unavailable.
      var latestCardStart=started+60000;
      if(admitted && typeof firebaseDirectoryTick_==='function' && Date.now()<latestCardStart) {
        try { firebaseDirectoryTick_(authorizedTimer); } catch(ignored) { /* Expired directory leases are denied by Firestore. */ }
      }
      if(admitted && typeof segmentCardMaintenanceTick_==='function' && Date.now()<=latestCardStart) {
        try { segmentCardMaintenanceTick_(authorizedTimer,latestCardStart); }
        catch(ignored){ /* The card scheduler records its own failure and retry. */ }
      }
    } finally {SHARED_REQUEST_SCOPE_=previous;}
  }
}
