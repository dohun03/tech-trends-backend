import { Test, TestingModule } from '@nestjs/testing';
import { StackOverflowScraper } from './stackoverflow.scraper';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('StackOverflowScraper', () => {
  let scraper: StackOverflowScraper;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StackOverflowScraper],
    }).compile();

    scraper = module.get<StackOverflowScraper>(StackOverflowScraper);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getArticles', () => {
    it('성공: MIN_SCORE 이상의 질문만 수집하여 UNIX 타임스탬프를 YYYY-MM-DD 형태로 변환해야 한다', async () => {
      const mockQuestions = {
        items: [
          {
            question_id: 101,
            title: 'NestJS Question',
            link: 'https://stackoverflow.com/q/101',
            creation_date: 1767225600, // 2026-01-01 (초 단위)
            score: 5,
          },
          {
            question_id: 102,
            title: 'Low Score Question',
            score: 1, // 필터링 대상 (3 미만)
          },
        ],
      };

      mockedAxios.get.mockResolvedValueOnce({ data: mockQuestions });

      const result = await scraper.getArticles();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('101');
      expect(result[0].created_at).toBe('2026-01-01');
    });
  });

  describe('getArticleDetails', () => {
    it('성공: 질문 본문, 조회수, 점수, 답변 수를 정확히 맵핑해야 한다', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          items: [
            {
              body: '<p>How to use NestJS?</p>',
              view_count: 150,
              score: 12,
              answer_count: 2,
            },
          ],
        },
      });

      const result = await scraper.getArticleDetails('101');

      expect(result).toEqual({
        content: '<p>How to use NestJS?</p>',
        view_count: 150,
        like_count: 12,
        comment_count: 2,
      });
    });
  });
});