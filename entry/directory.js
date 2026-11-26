// Bundled into the first Pages document. Only the Firebase project identifier is public configuration.
window.RegistryDirectoryReader = ((endpoint = 'https://firestore.googleapis.com') => {
  const encoder = new TextEncoder();
  const type = 'outreach-center/firebase-directory/v1';
  const maxAge = 600000;
  const deviceScope = 'outreach.dir.device.v1';
  const maxDeviceBytes = 256000;
  function projectOK(firebase,project) {
    return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(firebase) && ['numshield','neosender'].includes(project);
  }
  function documentRows(kind,project,checkedAt,expiresAt,rows,now) {
    if (!Number.isSafeInteger(checkedAt)||!Number.isSafeInteger(expiresAt)||checkedAt>now+60000||expiresAt<=now||expiresAt<=checkedAt||
        expiresAt-checkedAt>maxAge||!Array.isArray(rows)||rows.length>(kind==='sources'?5000:500)) return null;
    const ids=new Set(),items=[];
    for (const row of rows) {
      if (!row||typeof row.id!=='string'||!/^[\w-]{10,200}$/.test(row.id)||ids.has(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>255) return null;
      const item={id:row.id,name:row.name};
      if (kind==='segments') {
        if (row.project!==project||!['clients','partners'].includes(row.section)) return null;
        item.category=row.section;
      }
      items.push(item);ids.add(row.id);
    }
    return {kind,checkedAt,expiresAt,complete:true,items};
  }
  function base64(bytes) {
    let binary='';
    for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return btoa(binary);
  }
  function unbase64(text) { return Uint8Array.from(atob(text),ch=>ch.charCodeAt(0)); }
  function device(firebase,accessKey,project) {
    if (!projectOK(firebase,project)||!/^[\w-]{43}$/.test(accessKey))return null;
    const slot=deviceScope+'/'+firebase+'/'+project, scope=encoder.encode(slot);
    let imported;
    function key() {
      if(!imported)imported=window.crypto.subtle.importKey('raw',encoder.encode(accessKey),'HKDF',false,['deriveKey']).then(material=>
        window.crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode(deviceScope),info:scope},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']));
      return imported;
    }
    function discard(raw){try{if(window.localStorage.getItem(slot)===raw)window.localStorage.removeItem(slot);}catch{}}
    function parse(raw){
      if(!raw||raw.length>maxDeviceBytes*1.4)return null;
      let box;try{box=JSON.parse(raw);}catch{return null;}
      if(!box||typeof box.iv!=='string'||box.iv.length!==16||typeof box.box!=='string'||!Number.isSafeInteger(box.checkedAt)||box.checkedAt>Date.now()+60000||
          !Number.isSafeInteger(box.expiresAt)||box.expiresAt<=Date.now()||box.expiresAt-box.checkedAt>maxAge)return null;
      return box;
    }
    function prune(){try{const raw=window.localStorage.getItem(slot);if(raw&&!parse(raw))discard(raw);}catch{}}
    async function restore() {
      let raw;
      try{
        raw=window.localStorage.getItem(slot);if(!raw)return {};
        const box=parse(raw);if(!box){discard(raw);return {};}
        const plain=await window.crypto.subtle.decrypt({name:'AES-GCM',iv:unbase64(box.iv),additionalData:scope},await key(),unbase64(box.box));
        const saved=JSON.parse(new TextDecoder().decode(plain));
        if(saved.schema!==1||saved.firebase!==firebase||saved.project!==project)throw Error('scope');
        const docs={};
        for(const kind of ['sources','segments']){
          const doc=saved.docs?.[kind];
          if(!doc)continue;
          const valid=documentRows(kind,project,doc.checkedAt,doc.expiresAt,doc.rows,Date.now());
          if(valid)docs[kind]=valid;
        }
        if(window.localStorage.getItem(slot)!==raw)return {};
        if(!Object.keys(docs).length)discard(raw);
        return docs;
      }catch{discard(raw);return {};}
    }
    async function remember(docs,active) {
      try{
        const previous=window.localStorage.getItem(slot),saved={};
        let checkedAt=0,expiresAt=0;
        for(const kind of ['sources','segments']){
          const d=docs[kind];if(!d||d.expiresAt<=Date.now())continue;
          saved[kind]={checkedAt:d.checkedAt,expiresAt:d.expiresAt,rows:d.items.map(r=>kind==='sources'?{id:r.id,name:r.name}:
            {id:r.id,name:r.name,project,section:r.category})};
          checkedAt=Math.max(checkedAt,d.checkedAt);expiresAt=Math.max(expiresAt,d.expiresAt);
        }
        const plain=encoder.encode(JSON.stringify({schema:1,firebase,project,docs:saved}));
        if(!checkedAt||plain.length>maxDeviceBytes){if(active())discard(previous);return;}
        const iv=window.crypto.getRandomValues(new Uint8Array(12));
        const bytes=await window.crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:scope},await key(),plain);
        if(!active()||expiresAt<=Date.now())return;
        const current=window.localStorage.getItem(slot);
        if(previous&&current===null)return;
        if(parse(current)?.checkedAt>checkedAt)return;
        window.localStorage.setItem(slot,JSON.stringify({checkedAt,expiresAt,iv:base64(iv),box:base64(new Uint8Array(bytes))}));
      }catch{/* A device with private storage disabled still uses the verified network response. */}
    }
    return {restore,remember,prune,slot};
  }
  function clearDevice(firebase) {
    try{for(const project of ['numshield','neosender'])window.localStorage.removeItem(deviceScope+'/'+firebase+'/'+project);}catch{}
  }
  async function read(firebase, accessKey, project, signal) {
    if (!projectOK(firebase,project) || !/^[\w-]{43}$/.test(accessKey)) return {state:'denied'};
    const subtle = window.crypto.subtle;
    const key = await subtle.importKey('raw',encoder.encode(accessKey),'HKDF',false,['deriveBits']);
    const bits = await subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:encoder.encode(type),info:encoder.encode(firebase)},key,256);
    const capability = btoa(String.fromCharCode(...new Uint8Array(bits))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const db = 'projects/'+firebase+'/databases/(default)/documents', base = db+'/directoryViews/'+capability+'/lists/';
    const kinds = new Map([[base+'catalog','sources'],[base+'segments-'+project,'segments']]);
    const response = await window.fetch(endpoint+'/v1/'+db+':batchGet',{
      method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify({documents:[...kinds.keys()]}),
      credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',redirect:'error',signal
    });
    if (!response.ok) return {state:response.status===401||response.status===403?'denied':'unavailable'};
    const body = await response.text();
    if (body.length>3000000) return {state:'unavailable'};
    const batch = JSON.parse(body);
    if (!Array.isArray(batch) || batch.length!==2) return {state:'unavailable'};
    const result = {}, seen = new Set(), now = Date.now();
    for (const record of batch) {
      const kind = kinds.get(record?.found?.name || record?.missing);
      if (!kind || seen.has(kind)) return {state:'unavailable'};
      seen.add(kind);
      if (!record.found) continue;
      const fields = record.found.fields;
      if (String(fields?.schema?.integerValue)!=='1' || typeof fields.rowsJson?.stringValue!=='string') continue;
      const checkedAt=Date.parse(fields.generatedAt?.timestampValue), expiresAt=Date.parse(fields.expiresAt?.timestampValue);
      const raw=fields.rowsJson.stringValue;
      if (raw.length>850000 || encoder.encode(raw).length>850000) continue;
      let rows;
      try { rows=JSON.parse(raw); } catch { continue; }
      const valid=documentRows(kind,project,checkedAt,expiresAt,rows,now);
      if(valid)result[kind]=valid;
    }
    return {state:'ready',docs:result};
  }
  return {read,device,clearDevice};
})(/* directory service origin */);
