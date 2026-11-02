'use strict';
const {safeCover}=require('./player-view');
// Read-only presentation adapter; account, cookie refresh and playlist APIs stay in authority.
function createPlayerLibrary({authority,now=Date.now}) {
  const cache=new Map();
  const text=(v,n)=>String(v??'').slice(0,n);
  const song=s=>({songId:text(s.songId,20),title:text(s.title,200),artist:text(s.artist,200),coverUrl:safeCover(s.coverUrl),durationMs:Math.max(0,Number(s.durationMs)||0)});
  async function cached(key,load){
    const old=cache.get(key);if(old&&old.until>now())return old.value;
    const entry={until:now()+60000,value:Promise.resolve().then(load)};cache.set(key,entry);
    if(cache.size>12)cache.delete(cache.keys().next().value);
    try{return await entry.value;}catch(e){if(cache.get(key)===entry)cache.delete(key);throw e;}
  }
  return async input=>{
    if((input.op==='tracks'&&!/^\d{1,32}$/.test(input.playlistId))||(input.op==='search'&&(!input.query||input.query.length>80)))return {ok:false,error:'MUSIC_INPUT_ERROR',message:'请选择歌单或输入歌曲名称。'};
    // Cache only public metadata, scoped to this loaded account (never cache cookies).
    const status=authority.status();
    if(!status.connected){cache.clear();return {ok:false,error:'MUSIC_NOT_LOGGED_IN',message:'网易云暂未连接，请在原扫码页检查登录。'};}
    const account=String(status.profile?.userId||status.profile?.nickname||'current')+':'+String(status.connectedAt||'');
    try {
      let items;
      if(input.op==='playlists')items=await cached(account+':lists',async()=> (await authority.playlists()).map(p=>({playlistId:text(p.playlistId,32),name:text(p.name,120),count:Math.max(0,Number(p.count)||0),coverUrl:safeCover(p.coverUrl),mine:!!p.mine,liked:!!p.liked})).sort((a,b)=>Number(b.liked)-Number(a.liked)));
      else if(input.op==='tracks')items=await cached(account+':'+input.playlistId,async()=> (await authority.sourceSongs(input.playlistId)).map(song));
      else items=(await authority.search(input.query,20)).map(song);
      const offset=input.offset||0,limit=20;
      return {ok:true,op:input.op,items:items.slice(offset,offset+limit),offset,total:items.length,nextOffset:offset+limit<items.length?offset+limit:null,limit:input.op==='tracks'?500:input.op==='playlists'?100:20};
    }catch(e){
      const messages={MUSIC_NOT_LOGGED_IN:'网易云暂未连接，请在原扫码页检查登录。',MUSIC_LOGIN_EXPIRED:'网易云登录已过期，请在原扫码页重新扫码。',MUSIC_TIMEOUT:'歌单读取超时，请稍后重试。',MUSIC_AUTH_STORAGE_UNAVAILABLE:'登录态保存暂不可用，请稍后重试。'};
      const error=Object.hasOwn(messages,e.code)?e.code:'MUSIC_LIBRARY_UNAVAILABLE';
      return {ok:false,error,message:messages[error]||'暂时无法读取歌单或搜索结果，请重试。'};
    }
  };
}
module.exports={createPlayerLibrary};
