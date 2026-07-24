import { Injectable, Logger } from '@nestjs/common';
import Groq from 'groq-sdk';
import { GoogleGenAI } from '@google/genai';

export interface BatchEvaluationResult { valuable_ids: number[]; }
export interface FinalSummaryResult {
  title: string;
  short_summary: string[];
  long_summary: string;
  tags: string | null;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private groq: Groq;
  private gemini: GoogleGenAI;

  constructor() {
    this.groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    this.gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  // GROQ(QWEN) AI 평가
  async filterBatchWithAi(
    items: Array<{ id: number; title: string; snippet: string }>,
  ): Promise<number[]> {
    const prompt = `
    당신은 백엔드 개발자 시각의 IT 트렌드 큐레이터입니다.
    아래 10개 아티클 목록(제목 및 800자 요약)을 읽고, 백엔드/DevOps/CS/개발기술 측면에서 실무에 도움이 되는 가치 있는 글의 ID만 선택하세요.

    [제외 대상]
    - 수필, 개인 회고, 개발 커리어 고민, 소소한 일상
    - 단순 광고/홍보성 글

    [평가 대상]
    ${JSON.stringify(items, null, 2)}

    [응답 포맷 (JSON)]
    {
      "valuable_ids": [12345, 67890]
    }
    `;

    try {
      const response = await this.groq.chat.completions.create({
        model: 'qwen/qwen3.6-27b',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_completion_tokens: 4096,
        reasoning_effort: 'none',
      });

      const raw = response.choices[0]?.message?.content;
      if (!raw) return [];

      const parsed: BatchEvaluationResult = JSON.parse(raw);
      return parsed.valuable_ids || [];
    } catch (error: any) {
      this.logger.error(`[AI:Groq] 배치 가치 평가 실패 | error=${error.message}`);
      return [];
    }
  }

  // GROQ(QWEN) AI 요약
  async summarizeContentWithAi(
    title: string,
    content: string,
  ): Promise<FinalSummaryResult | null> {
    const prompt = `
    당신은 IT 트렌드 전문 에디터입니다.
    제공된 개발 블로그 글을 한국인 백엔드 개발자 시각으로 요약하세요.

    [글 정보]
    - 영문 제목: ${title}
    - 본문 내용: ${content}

    [작성 가이드]
    1. title: 기술 직관적인 한국어 제목
    2. short_summary: 핵심 내용 친근한 존댓말(~해요) 3문장 배열
    3. long_summary: 원문 내용에 따라서 300자~1000자 이상의 상세 마크다운 요약 (구체적인 개념, 기술 스택, 실습, 주요 제약 조건 포함)
    4. tags: 주요 기술 스택 쉼표 구분 문자열 (예: "NestJS, Redis")

    [응답 포맷 (JSON)]
    {
      "title": "가공된 한국어 제목",
      "short_summary": ["문장 1", "문장 2", "문장 3"],
      "long_summary": "마크다운 본문 요약...",
      "tags": "NestJS, TypeORM"
    }
    `;

    try {
      const response = await this.groq.chat.completions.create({
        model: 'qwen/qwen3.6-27b',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_completion_tokens: 4096,
        reasoning_effort: 'none',
      });

      const raw = response.choices[0]?.message?.content;
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      return {
        title: parsed.title || title,
        short_summary: Array.isArray(parsed.short_summary) ? parsed.short_summary : [parsed.short_summary],
        long_summary: parsed.long_summary || '',
        tags: Array.isArray(parsed.tags) ? parsed.tags.join(', ') : parsed.tags || null,
      };
    } catch (error: any) {
      this.logger.error(`[AI:Groq] 단일 아티클 요약 실패 | title="${title}", error=${error.message}`);
      return null;
    }
  }

  // GEMINI AI 벡터 임베딩
  async vectorEmbeddingWithAi(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    try {
      const response = await this.gemini.models.embedContent({
        model: 'gemini-embedding-001',
        contents: texts,
        config: {
          outputDimensionality: 1536,
        },
      });

      if (!response.embeddings || response.embeddings.length === 0) {
        return new Array(texts.length).fill([]);
      }

      return response.embeddings.map((e) => e.values || []);
    } catch (error: any) {
      this.logger.error(`[AI:Gemini] 임베딩 일괄 생성 실패 | error=${error.message}`);
      return new Array(texts.length).fill([]);
    }
  }
}