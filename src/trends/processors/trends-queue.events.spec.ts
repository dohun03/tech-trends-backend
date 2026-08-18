import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { TrendQueueEventsListener } from './trends-queue.events';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('TrendQueueEventsListener', () => {
  let listener: TrendQueueEventsListener;

  const mockAdminWebhook = 'https://discord.com/api/webhooks/admin';
  const mockUserWebhook = 'https://discord.com/api/webhooks/user';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrendQueueEventsListener,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'CLIENT_URL') return 'http://localhost:3000';
              if (key === 'DISCORD_ADMIN_WEBHOOK_URL') return mockAdminWebhook;
              if (key === 'DISCORD_USER_WEBHOOK_URL') return mockUserWebhook;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    listener = module.get<TrendQueueEventsListener>(TrendQueueEventsListener);

    jest.clearAllMocks();
  });

  describe('onCompleted 기본 테스트', () => {
    it('스크래핑 성공 시 관리자와 유저 채널 양쪽에 알림 메시지를 발송해야 한다', async () => {
      const mockReturnValue = {
        sourceName: 'GEEKS',
        savedCount: 1,
        savedArticles: [
          { 
            id: 99, 
            title: '단일 테스트 아티클',
            sourceId: 'geeks-99',
            url: 'https://geeks.com/99'
          }
        ],
      };

      mockedAxios.post.mockResolvedValue({ status: 200 });

      await listener.onCompleted({
        jobId: 'job-456',
        returnvalue: mockReturnValue,
      });

      // 총 2번 실행되었는지 검증
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);

      // 2번째 실행(유저 알림)에 유저 Webhook 주소와 안내 문구가 들어갔는지 검증
      expect(mockedAxios.post).toHaveBeenNthCalledWith(
        2,
        mockUserWebhook,
        expect.objectContaining({
          content: expect.stringContaining('📢 **[GEEKS] 새로운 트렌드 아티클이 도착했습니다!**'),
        }),
      );
    });

    it('아티클 목록이 1900자를 초과하면 메시지를 자르고 남은 개수를 표시해야 한다', async () => {
      const mockArticles = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        title: `엄청나게 긴 아티클 제목입니다. 테스트 용도입니다. ${i + 1}`.repeat(3),
        sourceId: `source-${i + 1}`,
        url: `https://example.com/${i + 1}`,
      }));

      const mockReturnValue = {
        sourceName: 'VELOG',
        savedCount: 50,
        savedArticles: mockArticles,
      };

      mockedAxios.post.mockResolvedValue({ status: 200 });

      await listener.onCompleted({
        jobId: 'job-123',
        returnvalue: JSON.stringify(mockReturnValue),
      });

      const userCallPayload = mockedAxios.post.mock.calls[1][1] as { content: string };
      
      expect(userCallPayload.content).toContain('...외');
      expect(userCallPayload.content).toMatch(/\*\*\d+개\*\*의 아티클이 더 있습니다\./);
    });
  });

  describe('onFailed 테스트', () => {
    it('작업 실패 시 관리자 채널로 실패 사유 메시지를 발송해야 한다', async () => {
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await listener.onFailed({
        jobId: 'job-999',
        failedReason: 'AI API Timeout',
      });

      expect(mockedAxios.post).toHaveBeenCalledWith(
        mockAdminWebhook,
        expect.objectContaining({
          content: expect.stringContaining('🚨 **[BullMQ 스크래퍼 실패]**'),
        }),
      );
    });
  });
});