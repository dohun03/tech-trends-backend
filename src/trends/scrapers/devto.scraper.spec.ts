import { Test, TestingModule } from '@nestjs/testing';
import { DevToScraper } from './devto.scraper';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('DevToScraper', () => {
  let scraper: DevToScraper;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DevToScraper],
    }).compile();

    scraper = module.get<DevToScraper>(DevToScraper);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getArticles', () => {
    it('성공: MIN_REACTIONS 및 MIN_COMMENTS 조건을 만족하는 아티클만 내림차순으로 정렬하여 반환해야 한다', async () => {
      const mockArticles = [
        {
          id: 1,
          title: '조건 미달 아티클',
          url: 'https://dev.to/1',
          published_at: '2026-01-01T00:00:00Z',
          positive_reactions_count: 5, // 미달 (10 미만)
          comments_count: 2,
        },
        {
          id: 2,
          title: '인기 아티클 1',
          url: 'https://dev.to/2',
          published_at: '2026-01-02T00:00:00Z',
          positive_reactions_count: 15,
          comments_count: 3,
        },
        {
          id: 3,
          title: '인기 아티클 2 (최고 좋아요)',
          url: 'https://dev.to/3',
          published_at: '2026-01-03T00:00:00Z',
          positive_reactions_count: 50,
          comments_count: 5,
        },
      ];

      mockedAxios.get.mockResolvedValueOnce({ data: mockArticles });

      const result = await scraper.getArticles();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('3'); // 반응 수 높은 순 정렬 확인
      expect(result[1].id).toBe('2');
      expect(result[0].created_at).toBe('2026-01-03');
    });

    it('실패: axios 요청 실패 시 에러를 던져야 한다', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('네트워크 에러'));

      await expect(scraper.getArticles()).rejects.toThrow('네트워크 에러');
    });
  });

  describe('getArticleDetails', () => {
    it('성공: 본문 마크다운과 통계 정보를 올바르게 반환해야 한다', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          body_markdown: '# Hello World',
          positive_reactions_count: 20,
          comments_count: 4,
        },
      });

      const result = await scraper.getArticleDetails('123');

      expect(result).toEqual({
        content: '# Hello World',
        view_count: null,
        like_count: 20,
        comment_count: 4,
      });
    });

    it('본문 내용이 비어있으면 null을 반환해야 한다', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { body_markdown: '   ' },
      });

      const result = await scraper.getArticleDetails('123');
      expect(result).toBeNull();
    });
  });
});