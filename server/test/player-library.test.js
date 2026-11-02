'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPlayerLibrary}=require('../music/player-library');
const {createMusicAuthority}=require('../music/authority');
const {createWidgetPlayback}=require('../music/widget-playback');
const song=id=>({songId:String(id),title:'Song '+id,artist:'Artist',coverUrl:'https://p1.music.126.net/test.jpg',durationMs:180000});

test('library reuses account UID, created/collected/liked playlists, song order and cookie handling without exposing account or secrets',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'earbud-library-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let accountCalls=0,refreshes=0,playlistCalls=0,now=1000,connected=true;
  const secret='TEST_ONLY_LIBRARY_COOKIE';
  const authority=createMusicAuthority({queueFile:path.join(dir,'queue.json'),store:{publicState:()=>({connected,profile:{nickname:'Test'}}),cookie:()=>secret,refreshCookie(){refreshes++;}},client:{
    account:async c=>{assert.equal(c,secret);accountCalls++;return {profile:{userId:'987'},cookie:secret};},
    userPlaylists:async(c,uid)=>{assert.equal(c,secret);assert.equal(uid,'987');playlistCalls++;return [{playlistId:'1',name:'Created',mine:true,count:45},{playlistId:'2',name:'Collected',mine:false,count:1},{playlistId:'3',name:'Liked',mine:true,liked:true,count:2,cookie:secret}];},
    playlistSongs:async(c,id,max)=>{assert.equal(c,secret);assert.equal(id,'1');assert.equal(max,500);return Array.from({length:45},(_,i)=>({...song(i+1),cookie:secret}));},
    search:async(c,q)=>{assert.equal(c,secret);assert.equal(q,'hello');return [{...song(99),cookie:secret}];}
  }});
  const library=createPlayerLibrary({authority,now:()=>now});
  const lists=await library({op:'playlists'});assert.equal(lists.items[0].liked,true);assert.equal(lists.items[1].mine,true);assert.equal(lists.items[2].mine,false);
  assert.equal(accountCalls,1);assert.equal(refreshes,1);await library({op:'playlists'});assert.equal(playlistCalls,1);
  const tracks=await library({op:'tracks',playlistId:'1',offset:20});assert.equal(tracks.items[0].songId,'21');assert.equal(tracks.items.length,20);assert.equal(tracks.nextOffset,40);assert.equal(tracks.total,45);
  const search=await library({op:'search',query:'hello'});assert.equal(search.items[0].coverUrl,song(99).coverUrl);
  assert.doesNotMatch(JSON.stringify([lists,tracks,search]),/cookie|TEST_ONLY_LIBRARY_COOKIE|987|profile/);
  assert.equal(authority.queue.get().items.length,0,'browsing never imports or plays a playlist');
  now+=60001;await library({op:'playlists'});assert.equal(playlistCalls,2);assert.equal(accountCalls,1);
  connected=false;assert.equal((await library({op:'playlists'})).error,'MUSIC_NOT_LOGGED_IN');
  connected=true;await library({op:'playlists'});assert.equal(playlistCalls,3);
  assert.equal((await library({op:'tracks'})).error,'MUSIC_INPUT_ERROR');
});

function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'earbud-pick-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let deferredId,resolve;
  const authority=createMusicAuthority({queueFile:path.join(dir,'queue.json'),store:{cookie:()=>'',refreshCookie(){}},client:{songDetail:async(c,id)=>{if(id===deferredId){deferredId=null;await new Promise(r=>resolve=r);}return song(id);},lyrics:async()=>({lines:[]}),playUrl:async()=>({url:'https://m701.music.126.net/test.mp3'})}});
  const adapter=createWidgetPlayback({authority,publicUrl:'https://music.example.test'});
  return {authority,adapter,defer(id){deferredId=id;},resolve(){resolve();}};
}
test('picking in a ChatGPT lease plays in the same epoch, is idempotent, rejects late old tracks and never grants an observer a second audio element',async t=>{
  const {authority,adapter}=setup(t),sourceId='widget-library-client',instanceId='mount-library-original';
  let p=authority.playbackOwner();await adapter.handle({op:'switch',sourceId,instanceId,target:'chatgpt',requestId:'library-switch-1',expectedEpoch:p.epoch,expectedStreamId:p.streamId});
  p=authority.playbackOwner();const claim=await adapter.handle({op:'claim',sourceId,instanceId,requestId:'library-claim-01',expectedEpoch:p.epoch,expectedStreamId:p.streamId});
  const lease=claim._meta.lease;
  const pick={op:'pick',sourceId,instanceId,...lease,songId:'1',requestId:'library-pick-001',expectedEpoch:p.epoch,expectedStreamId:p.streamId};
  const [a,b]=await Promise.all([adapter.handle(pick),adapter.handle(pick)]);
  assert.equal(a._meta.audio.trackId,b._meta.audio.trackId);assert.equal(a._meta.audio.playing,true);assert.equal(a._meta.audio.song.songId,'1');assert.equal(authority.queue.get().items.length,1);
  assert.equal(authority.playbackOwner().epoch,p.epoch);assert.equal(authority.playbackOwner().handoff,null);
  const old={op:'report',sourceId,instanceId,...lease,trackId:a._meta.audio.trackId,songId:'1',sequence:1,playing:true,positionMs:40000};
  assert.equal((await adapter.handle(old)).structuredContent.accepted,true);
  const newer=await adapter.handle({...pick,songId:'2',requestId:'library-pick-002'});assert.equal(newer._meta.audio.song.songId,'2');
  const rejected=await adapter.handle({...old,sequence:999,playing:false,positionMs:0});assert.equal(rejected.structuredContent.accepted,false);assert.equal(rejected.structuredContent.staleTrack,true);
  assert.equal((await adapter.handle({...pick,songId:'3'})).structuredContent.error,'REQUEST_ID_CONFLICT');
  const observer=await adapter.handle({op:'pick',sourceId,instanceId:'mount-library-observer',songId:'3',requestId:'observer-pick-003',expectedEpoch:p.epoch,expectedStreamId:p.streamId});
  assert.equal(observer.structuredContent.pending,true);assert.equal(observer._meta?.lease,undefined);assert.equal(observer._meta?.audio,undefined);
  assert.equal((await adapter.handle({...old,sequence:2})).structuredContent.staleTrack,true);
  const poll=await adapter.handle({op:'poll',sourceId,instanceId,...lease});assert.equal(poll._meta.audio.song.songId,'3');assert.equal(poll._meta.audio.playing,true);assert.equal(poll._meta.lease.sessionId,lease.sessionId);
  const report=await adapter.handle({op:'report',sourceId,instanceId,...lease,sequence:3,trackId:poll._meta.audio.trackId,songId:'3',positionMs:2000,playing:true});assert.equal(report.structuredContent.accepted,true);assert.equal(authority.nowPlaying().songId,'3');
  assert.equal(authority.playbackOwner().handoff,null);
});

test('PWA picks reuse the existing remote command; superseded or late picks cannot write after a mode change',async t=>{
  const f=setup(t),{authority,adapter}=f,p=authority.playbackOwner();
  const base={op:'pick',sourceId:'widget-library-pwa',instanceId:'mount-library-pwa',expectedEpoch:p.epoch,expectedStreamId:p.streamId};
  const first=await adapter.handle({...base,songId:'1',requestId:'pwa-library-pick-01'});assert.equal(first.structuredContent.pending,true);assert.equal(authority.playbackSync('pwa').command.itemId,authority.queue.get().currentId);assert.equal(authority.playbackOwner().mode,'pwa');assert.equal(authority.nowPlaying(),null);
  f.defer('2');const slow=adapter.handle({...base,songId:'2',requestId:'pwa-library-slow-02'});await new Promise(r=>setImmediate(r));
  await adapter.handle({...base,songId:'3',requestId:'pwa-library-newer-3'});f.resolve();assert.equal((await slow).structuredContent.error,'PLAYBACK_CHANGED');assert.equal(authority.queue.get().items.find(x=>x.id===authority.queue.get().currentId).songId,'3');
  f.defer('5');const olderThanWeb=adapter.handle({...base,songId:'5',requestId:'pwa-library-old-web'});await new Promise(r=>setImmediate(r));authority.queue.playNow({by:'you',song:song(6)});f.resolve();assert.equal((await olderThanWeb).structuredContent.error,'PLAYBACK_CHANGED');
  f.defer('4');const late=adapter.handle({...base,songId:'4',requestId:'pwa-library-late-04'});await new Promise(r=>setImmediate(r));
  authority.switchPlayback({target:'chatgpt',sourceId:base.sourceId,requestId:'library-mode-change',expectedEpoch:p.epoch,expectedStreamId:p.streamId});f.resolve();assert.equal((await late).structuredContent.error,'PLAYBACK_CHANGED');
  assert.equal(authority.queue.get().items.length,3);
});
