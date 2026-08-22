import { IsIn, IsOptional } from 'class-validator';
import { BaseTrendsQueryDto } from './base-trends-query.dto';

// [수정] MINED_ASC 추가
export type SortOption =
  | 'CREATED_DESC'
  | 'CREATED_ASC'
  | 'MINED_DESC'
  | 'MINED_ASC'
  | 'LIKE_DESC'
  | 'VIEW_DESC'
  | 'COMMENT_DESC'
  | 'RELEVANCE';

export class ListTrendsQueryDto extends BaseTrendsQueryDto {
  @IsOptional()
  @IsIn(
    [
      'CREATED_DESC',
      'CREATED_ASC',
      'MINED_DESC',
      'MINED_ASC', // [수정] MINED_ASC 추가
      'LIKE_DESC',
      'VIEW_DESC',
      'COMMENT_DESC',
    ],
    { message: '올바른 정렬 옵션을 선택해 주세요.' },
  )
  sort?: SortOption = 'CREATED_DESC';
}