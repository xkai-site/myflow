import sharp from 'sharp';
export const svgXml = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#135"/></linearGradient></defs><path d="M2 2h28v28H2z" fill="url(#paint)"/><text x="4" y="16" font-size="8">A &amp; B</text></svg>';
export const svgImage = {data:Buffer.from(svgXml).toString('base64'),mimeType:'image/svg+xml'};
export async function advancedFixtures() {
 const raw = Buffer.from([255,0,0,0, 0,255,0,255, 0,0,255,128, 255,0,0,255, 0,255,0,255, 0,0,255,255]);
 const original = await sharp({create:{width:3,height:2,channels:3,background:'#abc'}}).png().toBuffer();
 const overlay = await sharp(raw,{raw:{width:3,height:2,channels:4}}).png().toBuffer();
 const opaque = await sharp({create:{width:3,height:2,channels:4,background:{r:1,g:2,b:3,alpha:1}}}).png().toBuffer();
 const oriented = await sharp({create:{width:2,height:3,channels:3,background:'#abc'}}).jpeg().withMetadata({orientation:6}).toBuffer();
 const orientedOverlay = await sharp(raw,{raw:{width:2,height:3,channels:4}}).png().withMetadata({orientation:6}).toBuffer();
 const image = (bytes,mimeType='image/png')=>({data:bytes.toString('base64'),mimeType});
 return {original,overlay,opaque,oriented,orientedOverlay,image};
}
