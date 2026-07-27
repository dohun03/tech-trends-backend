export const sanitizeAndFilter = (markdown: string, limit = 800): string => {
  if (!markdown) return '';

  const cleaned = markdown
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/```[\s\S]*?```/g, '[코드 블록 생략]')
    .replace(/<[^>]*>?/gm, '')
    .replace(/\|?\s*:-+:?\s*\|?/g, '')
    .replace(/^-{3,}$/gm, '')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

  return cleaned.length > limit ? cleaned.substring(0, limit) + '...' : cleaned;
}