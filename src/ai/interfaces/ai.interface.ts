export type GeminiTaskType =
  | 'RETRIEVAL_DOCUMENT'
  | 'RETRIEVAL_QUERY'
  | 'SEMANTIC_SIMILARITY'
  | 'CLASSIFICATION'
  | 'CLUSTERING';

export interface BatchEvaluationItem {
  id: string;
  title: string;
  snippet: string;
}

export interface FilterBatchParams {
  items: BatchEvaluationItem[];
}

export interface SummarizeContentParams {
  title: string;
  content: string;
}

export interface BatchEvaluationResult {
  valuable_ids: string[];
}

export interface FinalSummaryResult {
  title: string;
  short_summary: string[];
  long_summary: string;
  tags: string | null;
}

export interface VectorEmbeddingParams {
  texts: string[];
  taskType?: GeminiTaskType;
}