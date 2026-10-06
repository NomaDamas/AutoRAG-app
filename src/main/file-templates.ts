/**
 * Template bytes for the "New File" formats.
 *
 * Text and Markdown are simply empty; RTF is a minimal valid document; the
 * three Office formats are real, openable OOXML packages built in memory with
 * fflate (already a dependency, and the app's own zip writer in
 * action-service). Every package carries the parts Word / PowerPoint / Excel
 * require to open the file, so a "new" document is never a corrupt stub.
 */

import { strToU8, zipSync } from "fflate";
import type { NewFileFormatId } from "../shared/new-file-contract";

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

const RTF_DOCUMENT = "{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Calibri;}}\\f0\\fs22 }";

/** An empty drawing canvas shared by every `spTree` in the presentation parts. */
const EMPTY_SP_TREE =
	`<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
	`<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>`;

const DOCX_PARTS: Readonly<Record<string, string>> = {
	"[Content_Types].xml":
		DECLARATION +
		`<Types xmlns="${CONTENT_TYPES_NS}">` +
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
		`<Default Extension="xml" ContentType="application/xml"/>` +
		`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
		`</Types>`,
	"_rels/.rels":
		DECLARATION +
		`<Relationships xmlns="${RELATIONSHIPS_NS}">` +
		`<Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/>` +
		`</Relationships>`,
	"word/document.xml":
		DECLARATION +
		`<w:document xmlns:w="${WORD_NS}"><w:body><w:p/>` +
		`<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
		`<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>` +
		`</w:body></w:document>`,
};

const XLSX_PARTS: Readonly<Record<string, string>> = {
	"[Content_Types].xml":
		DECLARATION +
		`<Types xmlns="${CONTENT_TYPES_NS}">` +
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
		`<Default Extension="xml" ContentType="application/xml"/>` +
		`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
		`<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
		`</Types>`,
	"_rels/.rels":
		DECLARATION +
		`<Relationships xmlns="${RELATIONSHIPS_NS}">` +
		`<Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/>` +
		`</Relationships>`,
	"xl/workbook.xml":
		DECLARATION +
		`<workbook xmlns="${SHEET_NS}" xmlns:r="${OFFICE_REL}">` +
		`<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>` +
		`</workbook>`,
	"xl/_rels/workbook.xml.rels":
		DECLARATION +
		`<Relationships xmlns="${RELATIONSHIPS_NS}">` +
		`<Relationship Id="rId1" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
		`</Relationships>`,
	"xl/worksheets/sheet1.xml": DECLARATION + `<worksheet xmlns="${SHEET_NS}"><sheetData/></worksheet>`,
};

const PPTX_PARTS: Readonly<Record<string, string>> = {
	"[Content_Types].xml":
		DECLARATION +
		`<Types xmlns="${CONTENT_TYPES_NS}">` +
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
		`<Default Extension="xml" ContentType="application/xml"/>` +
		`<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
		`<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
		`<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
		`<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>` +
		`<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
		`</Types>`,
	"_rels/.rels":
		DECLARATION +
		`<Relationships xmlns="${RELATIONSHIPS_NS}">` +
		`<Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="ppt/presentation.xml"/>` +
		`</Relationships>`,
	"ppt/presentation.xml":
		DECLARATION +
		`<p:presentation xmlns:a="${DRAWING_NS}" xmlns:r="${OFFICE_REL}" xmlns:p="${PRESENTATION_NS}">` +
		`<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
		`<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>` +
		`<p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/>` +
		`</p:presentation>`,
	"ppt/_rels/presentation.xml.rels":
		DECLARATION +
		`<Relationships xmlns="${RELATIONSHIPS_NS}">` +
		`<Relationship Id="rId1" Type="${OFFICE_REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
		`<Relationship Id="rId2" Type="${OFFICE_REL}/slide" Target="slides/slide1.xml"/>` +
		`<Relationship Id="rId3" Type="${OFFICE_REL}/theme" Target="theme/theme1.xml"/>` +
		`</Relationships>`,
	"ppt/slideMasters/slideMaster1.xml":
		DECLARATION +
		`<p:sldMaster xmlns:a="${DRAWING_NS}" xmlns:r="${OFFICE_REL}" xmlns:p="${PRESENTATION_NS}">` +
		`<p:cSld>${EMPTY_SP_TREE}</p:cSld>` +
		`<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
		`<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
		`<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>` +
		`</p:sldMaster>`,
	"ppt/slideMasters/_rels/slideMaster1.xml.rels":
		DECLARATION +
		`<Relationships xmlns="${RELATIONSHIPS_NS}">` +
		`<Relationship Id="rId1" Type="${OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
		`<Relationship Id="rId2" Type="${OFFICE_REL}/theme" Target="../theme/theme1.xml"/>` +
		`</Relationships>`,
	"ppt/slideLayouts/slideLayout1.xml":
		DECLARATION +
		`<p:sldLayout xmlns:a="${DRAWING_NS}" xmlns:r="${OFFICE_REL}" xmlns:p="${PRESENTATION_NS}" type="blank" preserve="1">` +
		`<p:cSld name="Blank">${EMPTY_SP_TREE}</p:cSld>` +
		`<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
		`</p:sldLayout>`,
	"ppt/slideLayouts/_rels/slideLayout1.xml.rels":
		DECLARATION +
		`<Relationships xmlns="${RELATIONSHIPS_NS}">` +
		`<Relationship Id="rId1" Type="${OFFICE_REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
		`</Relationships>`,
	"ppt/slides/slide1.xml":
		DECLARATION +
		`<p:sld xmlns:a="${DRAWING_NS}" xmlns:r="${OFFICE_REL}" xmlns:p="${PRESENTATION_NS}">` +
		`<p:cSld>${EMPTY_SP_TREE}</p:cSld>` +
		`<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
		`</p:sld>`,
	"ppt/slides/_rels/slide1.xml.rels":
		DECLARATION +
		`<Relationships xmlns="${RELATIONSHIPS_NS}">` +
		`<Relationship Id="rId1" Type="${OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
		`</Relationships>`,
	"ppt/theme/theme1.xml":
		DECLARATION +
		`<a:theme xmlns:a="${DRAWING_NS}" name="Office Theme"><a:themeElements>` +
		`<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
		`<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2>` +
		`<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>` +
		`<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>` +
		`<a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>` +
		`<a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>` +
		`<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>` +
		`<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
		`<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
		`<a:fmtScheme name="Office"><a:fillStyleLst>` +
		`<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
		`<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
		`<a:lnStyleLst>` +
		`<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>` +
		`<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>` +
		`<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>` +
		`</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>` +
		`<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
		`<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
		`<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
		`</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`,
};

/** Zip the OOXML parts into a package (deflate, the level the app's zip writer uses). */
function ooxmlPackage(parts: Readonly<Record<string, string>>): Uint8Array {
	const files: Record<string, Uint8Array> = {};
	for (const [name, xml] of Object.entries(parts)) {
		files[name] = strToU8(xml);
	}
	return zipSync(files, { level: 6 });
}

/** The bytes a new file of `format` starts with. */
export function newFileContents(format: NewFileFormatId): Uint8Array {
	switch (format) {
		case "text":
		case "markdown":
			return new Uint8Array();
		case "rtf":
			return strToU8(RTF_DOCUMENT);
		case "word":
			return ooxmlPackage(DOCX_PARTS);
		case "excel":
			return ooxmlPackage(XLSX_PARTS);
		case "powerpoint":
			return ooxmlPackage(PPTX_PARTS);
	}
}
