import { IsNotEmpty, IsString, IsOptional, IsIn } from 'class-validator';
import { BaseTrendsQueryDto } from './base-trends-query.dto';
// [수정] type 키워드를 추가하여 타입 전용 임포트로 명시
import type { SortOption } from './list-trends-query.dto';

export class SearchTrendsQueryDto extends BaseTrendsQueryDto {
  @IsString({ message: '검색어는 문자열이어야 합니다.' })
  @IsNotEmpty({ message: '검색어를 입력해 주세요.' })
  search!: string;

  @IsOptional()
  @IsIn(['hybrid', 'keyword'], { message: '검색 타입은 hybrid 또는 keyword 이어야 합니다.' })
  searchType?: 'hybrid' | 'keyword';

  @IsOptional()
  @IsIn(
    [
      'RELEVANCE',
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
  sort?: SortOption = 'RELEVANCE';
}