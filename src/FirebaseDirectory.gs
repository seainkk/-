/** The file ID pins an owner-only writer configuration in the root of My Drive. */
var FIREBASE_DIRECTORY = Object.freeze({project:'outreach-directory', configId:'1Q8sUzqaTQpyvGbDp4e4BPakRRDYlzL-l',
  binding:'FIREBASE_DIRECTORY_BINDING_V1', clock:'FIREBASE_DIRECTORY_CLOCK_V1', timerCheck:'FIREBASE_DIRECTORY_TIMER_CHECK_V1',
  interval:300000, lifetime:600000});

function firebaseDirectoryCap_(rawKey, project) {
  function bytes(s) { return Utilities.newBlob(s).getBytes(); }
  var prk = Utilities.computeHmacSha256Signature(bytes(rawKey),bytes('outreach-center/firebase-directory/v1'));
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(bytes(project).concat([1]),prk)).replace(/=+$/,'');
}

function firebaseDirectoryArm_(key) {
  if (!FIREBASE_DIRECTORY.configId) return;
  var context=authorize_(), props=context.properties, hash=SHARED_REQUEST_SCOPE_.keyHash;
  var raw=props.getProperty(FIREBASE_DIRECTORY.binding), prior=raw && JSON.parse(raw);
  if (prior && prior.hash===hash && prior.root===context.rootId && prior.project===FIREBASE_DIRECTORY.project && prior.file===FIREBASE_DIRECTORY.configId) {
    var clock=JSON.parse(props.getProperty(FIREBASE_DIRECTORY.clock)||'{}'), now=Date.now();
    if (clock.lastSuccess>now-FIREBASE_DIRECTORY.lifetime) return;
    var check=segmentCardMaintenanceLock_(100,function(){
      if(Number(props.getProperty(FIREBASE_DIRECTORY.timerCheck))>now-FIREBASE_DIRECTORY.interval) return false;
      props.setProperty(FIREBASE_DIRECTORY.timerCheck,String(now)); return true;
    });
    if(check) coldyIncomingEnsure_(context,false);
    return;
  }
  var cap=firebaseDirectoryCap_(key,FIREBASE_DIRECTORY.project);
  var timer=coldyIncomingEnsure_(context,false);
  if (!timer.enabled || sharedConfiguredHash_(props)!==hash) return;
  props.setProperty(FIREBASE_DIRECTORY.binding,JSON.stringify({hash:hash,root:context.rootId,project:FIREBASE_DIRECTORY.project,file:FIREBASE_DIRECTORY.configId,cap:cap}));
  props.setProperty(FIREBASE_DIRECTORY.timerCheck,String(Date.now()));
  props.deleteProperty(FIREBASE_DIRECTORY.clock);
}

function firebaseDirectoryConfig_(context) {
  var id=id_(FIREBASE_DIRECTORY.configId), opts={fields:'id,trashed,shared,ownedByMe,mimeType,parents,properties,version',supportsAllDrives:true};
  var file=Drive.Files.get(id,opts), home=Drive.Files.get('root',{fields:'id'});
  if (file.id!==id || file.trashed!==false || file.shared!==false || file.ownedByMe!==true || file.mimeType!=='application/json' ||
      !file.properties || file.properties.outreachDirectoryWriter!==FIREBASE_DIRECTORY.project || !file.parents ||
      file.parents.length!==1 || file.parents[0]!==home.id || home.id===context.rootId)
    throw Error('Unavailable private directory writer');
  var config=JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8'));
  if (config.project!==FIREBASE_DIRECTORY.project || config.root!==context.rootId || !/^[\w-]{43}$/.test(config.writer) ||
      Drive.Files.get(id,{fields:'version'}).version!==file.version) throw Error('Invalid directory writer');
  return {writer:config.writer,version:file.version};
}

function firebaseDirectoryScope_(props) {
  var values=props.getProperties();
  var keys=Object.keys(values).filter(function(k){return /^(ROOT_FOLDER_ID|SOURCE_BASES_FOLDER_ID|SOURCE_BASES_STORAGE_ID|SEGMENTS_FOLDER_ID|SHARED_ACCESS_KEY_SHA256)$|^(REGISTRY_SEGMENT_PROJECT_|SEGMENT_CATEGORY_)/.test(k);}).sort();
  return digest_(JSON.stringify(keys.map(function(k){return [k,values[k]];})));
}

function firebaseDirectoryRows_(directory, project) {
  if (!directory || directory.state!=='ready' || !directory.complete || !Array.isArray(directory.items) ||
      (project && directory.projectId!==project) || directory.items.length>(project?500:5000)) throw Error('Incomplete directory');
  var ids=new Set(),rows=directory.items.map(function(item) {
    var id=id_(item.id),name=item.name;
    if(ids.has(id)||typeof name!=='string'||!name.trim()||name.length>255)throw Error('Invalid directory row');
    ids.add(id);
    if (!project) return {id:id,name:name};
    if (['clients','partners'].indexOf(item.category)<0)throw Error('Invalid directory section');
    return {id:id,name:name,project:project,section:item.category};
  }),json=JSON.stringify(rows);
  if(Utilities.newBlob(json).getBytes().length>850000)throw Error('Directory size limit');
  return json;
}

function firebaseDirectoryCommit_(binding,config,rows,at) {
  var base='projects/'+FIREBASE_DIRECTORY.project+'/databases/(default)/documents/', time=new Date(at).toISOString(), until=new Date(at+FIREBASE_DIRECTORY.lifetime).toISOString();
  var dates={generatedAt:{timestampValue:time},expiresAt:{timestampValue:until}};
  var writes=[{update:{name:base+'directoryWrites/'+config.writer,fields:{}},updateTransforms:[{fieldPath:'stamp',setToServerValue:'REQUEST_TIME'}]},
    {update:{name:base+'directoryControl/active',fields:Object.assign({capability:{stringValue:binding.cap},verifier:{stringValue:binding.hash}},dates)}}];
  ['catalog','segments-numshield','segments-neosender'].forEach(function(list){
    writes.push({update:{name:base+'directoryViews/'+binding.cap+'/lists/'+list,fields:Object.assign({schema:{integerValue:'1'},rowsJson:{stringValue:rows[list]}},dates)}});
  });
  var response=UrlFetchApp.fetch('https://firestore.googleapis.com/v1/'+base.slice(0,-1)+':commit',{
    method:'post',contentType:'application/json',payload:JSON.stringify({writes:writes}),muteHttpExceptions:true,followRedirects:false});
  var code=response.getResponseCode();
  if(code!==200){
    var error=Error('Directory publication declined');
    error.directoryHttp=code;
    throw error;
  }
}

/** Uses the authorized incoming minute trigger. Its lease keeps slow generations from overlapping. */
function firebaseDirectoryTick_(guard) {
  if (!FIREBASE_DIRECTORY.configId) return;
  var context=guard(),props=context.properties,raw=props.getProperty(FIREBASE_DIRECTORY.binding);
  if (!raw) return;
  var binding=JSON.parse(raw),at=Date.now(),id=Utilities.getUuid(),previous=SHARED_REQUEST_SCOPE_;
  function valid() {
    var active=guard();
    return active.rootId===binding.root && binding.project===FIREBASE_DIRECTORY.project && binding.file===FIREBASE_DIRECTORY.configId &&
      active.properties.getProperty(FIREBASE_DIRECTORY.binding)===raw && sharedConfiguredHash_(active.properties)===binding.hash &&
      previous.keyHash===binding.hash;
  }
  if (!valid())return;
  var lastSuccess=0;
  var claim=segmentCardMaintenanceLock_(100,function(){
    var clock=JSON.parse(props.getProperty(FIREBASE_DIRECTORY.clock)||'{}');
    if(clock.next>at)return false;
    lastSuccess=Number(clock.lastSuccess)||0;
    props.setProperty(FIREBASE_DIRECTORY.clock,JSON.stringify({next:at+240000,claim:id,lastSuccess:lastSuccess}));return true;
  });
  if(!claim)return;
  var success=false, stage='writer';
  try {
    var cfg=firebaseDirectoryConfig_(context),scope=firebaseDirectoryScope_(props),rows={};
    stage='catalog'; rows.catalog=firebaseDirectoryRows_(getSourceDirectory_());
    ['numshield','neosender'].forEach(function(project){
      SHARED_REQUEST_SCOPE_={keyHash:binding.hash,projectId:project,automation:true};
      stage='segments-'+project;
      rows['segments-'+project]=firebaseDirectoryRows_(getSegmentDirectory_(),project);
    });
    SHARED_REQUEST_SCOPE_=previous;
    stage='scope';
    if(Drive.Files.get(FIREBASE_DIRECTORY.configId,{fields:'version'}).version!==cfg.version ||
       !valid()||scope!==firebaseDirectoryScope_(props)||Date.now()-at>180000||
       JSON.parse(props.getProperty(FIREBASE_DIRECTORY.clock)||'{}').claim!==id)return;
    stage='publish'; firebaseDirectoryCommit_(binding,cfg,rows,at);success=true;
  } catch (error) {
    if(Number.isInteger(error.directoryHttp) && error.directoryHttp>=100 && error.directoryHttp<=599) stage='http_'+error.directoryHttp;
    // Third-party error messages may contain document paths. Persist only the allowlisted stage or HTTP code.
  } finally {
    SHARED_REQUEST_SCOPE_=previous;
    segmentCardMaintenanceLock_(200,function(){
      if(JSON.parse(props.getProperty(FIREBASE_DIRECTORY.clock)||'{}').claim===id)
        props.setProperty(FIREBASE_DIRECTORY.clock,JSON.stringify({next:(success?at+FIREBASE_DIRECTORY.interval:Date.now()+60000),
          lastSuccess:success?at:lastSuccess,at:at,issue:success?null:stage}));
    });
  }
}
