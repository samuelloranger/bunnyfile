function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Decodes the five predefined entities and numeric character references.
 * Null when a reference names a code point XML does not allow.
 */
export function unescapeXml(value: string): string | null {
  let invalid = false;
  const out = value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, ref: string) => {
    if (!ref.startsWith('#')) {
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[ref]!;
    }
    const cp = ref.startsWith('#x')
      ? Number.parseInt(ref.slice(2), 16)
      : Number.parseInt(ref.slice(1), 10);
    // XML 1.0 Char: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
    const allowed =
      cp === 0x9 ||
      cp === 0xa ||
      cp === 0xd ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff);
    if (!allowed) {
      invalid = true;
      return '';
    }
    return String.fromCodePoint(cp);
  });
  return invalid ? null : out;
}

type XmlNode = {
  name: string;
  value?: string;
  attributes?: Record<string, string>;
  children?: XmlNode[];
};

function renderNode(node: XmlNode): string {
  const attrs = node.attributes
    ? Object.entries(node.attributes)
        .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
        .join('')
    : '';
  const open = `<${node.name}${attrs}>`;
  const close = `</${node.name}>`;
  if (node.children && node.children.length > 0) {
    return `${open}${node.children.map(renderNode).join('')}${close}`;
  }
  return `${open}${escapeXml(node.value ?? '')}${close}`;
}

export function xmlDocument(root: XmlNode): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${renderNode(root)}`;
}

export function s3ErrorXml(code: string, message: string, resource?: string): string {
  return xmlDocument({
    name: 'Error',
    children: [
      { name: 'Code', value: code },
      { name: 'Message', value: message },
      ...(resource ? [{ name: 'Resource', value: resource }] : []),
    ],
  });
}
