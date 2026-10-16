// Synthetic values: preserve the shapes of observed content, not customer text or URLs.
export const fixtures = [
  { id: 'basic', html: '<h2>Heading</h2><p>Hello <strong>world</strong>.</p>' },
  { id: 'lexical', html: "<P class='x'> A &rsquo; B &#160; C\r\n D <b>bold</b><br /></P><!--keep-->" },
  { id: 'finance-shape', html: '<h6 style="text-align: center;"><span class="theme-primary">Intro</span>\n</h6>\n<h2 style="text-align: center;">Heading\n</h2><p style="text-align: center;">A &rsquo; <span style="text-align: center;">&lt;PRODUCT&gt;</span></p>' },
  { id: 'styles', html: '<p id="anchor" class="theme-primary" data-custom="keep" style="text-align:right;margin:12px"><span style="color:#ff0000;font-family:Arial;font-size:18px;background-color:#ffffff;line-height:1.5">Text</span></p>' },
  { id: 'table', html: '<div style="overflow-x:auto"><style>table,td{border:1px solid black}</style><table style="width:882px;height:399px" class="data"><caption>Caption</caption><tbody><tr><th scope="col">Name</th><td colspan="2" style="width:95px">Value</td></tr></tbody></table></div>' },
  { id: 'internal-link', html: '<p><a href="~/link.aspx?_id=11111111111111111111111111111111&amp;_z=z" class="cta" title="Go" data-sc-id="11111111111111111111111111111111">Go</a></p>' },
  { id: 'media-link', html: '<p><a href="-/media/11111111111111111111111111111111.ashx?la=en&amp;hash=abc" target="_self" download="guide.pdf">Guide</a></p>' },
  { id: 'media-image', html: '<p>Before<img src="-/media/11111111111111111111111111111111.ashx" alt="Logo" width="264" height="60" mediaid="{11111111-1111-1111-1111-111111111111}" />After</p>' },
  { id: 'dam-image', html: '<img src="https://assets.example.test/api/public/content/sample?v=version" alt="Logo" width="264" height="60" stylelabs-content-id="42" stylelabs-content-type="Image" thumbnailsrc="https://assets.example.test/thumbnail" mediaid="" />' },
  { id: 'unknown', html: '<section id="s"><custom-card data-key="42"><p>Inside</p></custom-card></section><p><span data-token="x" aria-label="Token">Token</span></p>' },
  { id: 'embedded-css', html: '<style>.theme-primary{color:red} @import url("https://assets.example.test/style.css");</style><p class="theme-primary">Styled</p>' },
  { id: 'lists', html: '<ol start="3"><li value="7">First<ul><li>Nested</li></ul></li></ol><pre><code class="language-js">a  b\n c</code></pre>' },
  { id: 'empty', html: '' },
  { id: 'malformed', html: '<p>A<div>B</div>C</p><p title="first" title="second">D' },
];
