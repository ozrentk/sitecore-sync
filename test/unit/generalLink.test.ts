import { test } from "node:test";
import { strictEqual, deepStrictEqual, throws, rejects } from "node:assert";
import { generalLinkInput, parseGeneralLink, serializeGeneralLink, validateLinkTarget, validateLinkValues, linkSourceReason } from "../../src/editor/generalLink";
import type { AuthoringItemField, AuthoringTreeItem } from "../../src/sitecore/authoringClient";

const id = "11111111111111111111111111111111";
const external = '<link text="Home" linktype="external" url="https://example.test/path?a=1&amp;b=2" target="_blank" />';
const edit = (raw: string, patch: Record<string, string | undefined>) => JSON.stringify({ ...JSON.parse(generalLinkInput(raw)), ...patch });
const field = (value = external, selectionSource: string | undefined = ""): AuthoringItemField => ({ fieldId:id,name:"Link",label:"Link",type:"General Link",typeKey:"general link",value,scope:"VERSIONED",sortOrder:0,sectionSortOrder:0,sectionName:"Content",isStandardTemplate:false,containsFallbackValue:false,containsInheritedValue:false,containsStandardValue:false,textual:false,selectionSource });

test("General Link ordinary variants round-trip and edit XML text without normalizing untouched attributes", () => {
  const variants = [external, `<link text='Home' anchor='' linktype='internal' class='' title='' target='_blank' querystring='' id='{11111111-1111-1111-1111-111111111111}' />`,
    '<link linktype="mailto" url="mailto:name@example.test"></link>', '<link linktype="anchor" url="section" />', '<link linktype="anchor" anchor="section" />'];
  for (const raw of variants) {
    strictEqual(serializeGeneralLink(raw, generalLinkInput(raw)), raw);
    const changed = serializeGeneralLink(raw, edit(raw, {text:'<雪 & "quote" \' 😀>'}));
    strictEqual(parseGeneralLink(changed).values.text, '<雪 & "quote" \' 😀>');
    strictEqual(changed.includes("&amp;"), true); strictEqual(changed.includes("&quot;"), true);
  }
  const raw = " <link  linktype='external' url='https://example.test' text = 'Old' /> ";
  strictEqual(serializeGeneralLink(raw,edit(raw,{text:"New"})), " <link  linktype='external' url='https://example.test' text=\"New\" /> ");
  const created = serializeGeneralLink("", edit("", {url:"https://example.test"}));
  strictEqual(parseGeneralLink(created).values.url,"https://example.test");
  const anchor = serializeGeneralLink("", edit("",{linktype:"anchor",url:"section"}));
  strictEqual(parseGeneralLink(anchor).values.url,"section");
  throws(()=>validateLinkValues({...parseGeneralLink(anchor).values,anchor:"different"}),/Conflicting/);
});
test("General Link unknown DAM attributes survive unrelated edits and clear/save undo", () => {
  const raw = '<link linktype="external" url="https://assets.example.test/file" text="Old" dam-id="123" FileSize = \'1&amp;2\' data-extra="%20" />';
  const changed = serializeGeneralLink(raw,edit(raw,{text:"New",title:"Title"}));
  strictEqual(changed.includes('dam-id="123" FileSize = \'1&amp;2\' data-extra="%20"'),true);
  strictEqual(serializeGeneralLink("",generalLinkInput(raw)),raw);
  throws(()=>serializeGeneralLink(raw,edit(raw,{url:"https://other.test"})),/Custom/);
  throws(()=>serializeGeneralLink(raw,JSON.stringify({...JSON.parse(edit(raw,{text:"New"})),_xml:external})),/Custom/);
  throws(()=>serializeGeneralLink(external,JSON.stringify({...JSON.parse(edit(external,{text:"New"})),_xml:raw})),/Custom/);
});
test("General Link rejects malformed XML, unsupported variants and unsafe destinations", () => {
  for (const raw of ['<!DOCTYPE link><link />','<link linktype="external" url="&unknown;"/>','<link linktype="external" linktype="anchor"/>','<link linktype="external"><child/></link>', '<link linktype="javascript" url="alert(1)"/>','<link linktype="media" id="'+id+'"/>','<link linktype="dam"/>','<link xmlns="custom" linktype="external"/>','<link linktype="external" x:attr="x"/>','<link linktype="external" url="&#0;"/>']) throws(()=>parseGeneralLink(raw));
  for (const url of ['javascript:alert(1)','data:text/html,x','file:///tmp/file','//example.test','https://user:password@example.test','https:\\example.test','https://example.test/\npath']) throws(()=>serializeGeneralLink(external,edit(external,{url})));
  for (const patch of [{linktype:"mailto",url:"mailto:x@example.test?bcc=other@example.test"},{linktype:"internal",id:"bogus"},{linktype:"anchor",anchor:"#fragment"},{target:"_invalid"}]) throws(()=>serializeGeneralLink(external,edit(external,patch)));
  const bad='<link linktype="external" url="javascript:alert(1)"/>';
  throws(()=>serializeGeneralLink("",generalLinkInput(bad))); // forged retained XML cannot bypass validation
  throws(()=>serializeGeneralLink("",generalLinkInput('<link linktype="anchor" anchor="x" url="javascript:alert(1)"/>')));
  throws(()=>serializeGeneralLink(external,'{}'));
  validateLinkValues(parseGeneralLink(external).values);
});
test("General Link validates only new internal destinations in pinned Source and propagates read failures", async () => {
  const root: AuthoringTreeItem = {itemId:"22222222222222222222222222222222",name:"Root",displayName:"Root",path:"/sitecore/content/Root",hasChildren:true};
  const target = {...root,itemId:id,name:"Child",path:root.path+"/Child"};
  const locators: unknown[] = [];
  const io={item:async(locator:unknown)=>{locators.push(locator);return locators.length===1?root:target;},children:async()=>({item:root,children:[]})};
  const value=serializeGeneralLink("",edit("",{linktype:"internal",id}));
  await validateLinkTarget(field("",root.path),value,io); deepStrictEqual(locators,[{path:root.path},{itemId:id}]);
  locators.length=0; await validateLinkTarget(field(value,root.path),serializeGeneralLink(value,edit(value,{text:"New"})),io); strictEqual(locators.length,0);
  await rejects(validateLinkTarget(field("",root.path),value,{...io,item:async()=>{throw Error("cancelled");}}),/cancelled/);
  await rejects(validateLinkTarget(field("",root.path),value,{...io,item:async locator=>"path" in locator?root:{...target,path:"/sitecore/content/Other"}}),/outside/);
  strictEqual(linkSourceReason(field()),undefined);
  strictEqual(Boolean(linkSourceReason({...field(),selectionSource:undefined})),true);
  strictEqual(Boolean(linkSourceReason(field("","query:./*"))),true);
  await rejects(validateLinkTarget(field("",root.path),value,{...io,item:async locator=>"path" in locator?{...root,path:"/sitecore/content/Other"}:target}),/outside/);
});
