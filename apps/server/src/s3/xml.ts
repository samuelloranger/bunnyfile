function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
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
