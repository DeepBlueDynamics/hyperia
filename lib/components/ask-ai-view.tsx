import React from 'react';

import './ask-ai-view.css';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
}

export interface AskAiViewProps {
  url: string;
  aiConversations: Conversation[];
  aiStreamingMessage: string;
  searchState: 'idle' | 'searching' | 'completed' | 'error';
  searchLogs: Array<{
    id: string;
    name: string;
    input?: any;
    output?: string;
    status: 'running' | 'ok' | 'fail';
    expanded?: boolean;
  }>;
  aiInputVal: string;

  onUpdateState: (updates: any) => void;
  onRunAiChat: (conversationId: string, val: string) => Promise<void> | void;
  onStopAgentSearch: () => void;
}

export const AskAiView: React.FC<AskAiViewProps> = (props) => {
  const {
    url,
    aiConversations,
    aiStreamingMessage,
    searchState,
    searchLogs,
    aiInputVal,
    onUpdateState,
    onRunAiChat,
    onStopAgentSearch
  } = props;

  const conversationId = url.slice(5);
  const activeConv = aiConversations.find((c) => c.id === conversationId) || {
    id: conversationId,
    title: 'ask',
    messages: []
  };

  return (
    <div className="ai_pane_container hy-askai-root">
      {/* Chat feed scroll area */}
      <div className="ai_pane_feed hy-askai-feed">
        {activeConv.messages.map((msg, idx) => {
          const isUser = msg.role === 'user';
          return (
            <div key={idx} className={isUser ? 'hy-askai-row hy-askai-row--user' : 'hy-askai-row'}>
              <div className={isUser ? 'hy-askai-bubble hy-askai-bubble--user' : 'hy-askai-bubble'}>
                {(() => {
                  const parts = msg.content.split(/(```[\s\S]*?```)/g);
                  return parts.map((part: string, pIdx: number) => {
                    if (part.startsWith('```')) {
                      const code = part.replace(/```[a-zA-Z0-9]*\n?|```$/g, '');
                      return (
                        <pre key={pIdx} className="hy-askai-code">
                          <code>{code}</code>
                        </pre>
                      );
                    }
                    return <span key={pIdx}>{part}</span>;
                  });
                })()}
              </div>
            </div>
          );
        })}

        {/* Streaming message from assistant */}
        {aiStreamingMessage && (
          <div className="hy-askai-row">
            <div className="hy-askai-bubble">
              {(() => {
                const parts = aiStreamingMessage.split(/(```[\s\S]*?```)/g);
                return parts.map((part: string, pIdx: number) => {
                  if (part.startsWith('```')) {
                    const code = part.replace(/```[a-zA-Z0-9]*\n?|```$/g, '');
                    return (
                      <pre key={pIdx} className="hy-askai-code">
                        <code>{code}</code>
                      </pre>
                    );
                  }
                  return (
                    <span key={pIdx}>
                      {part}
                      {pIdx === parts.length - 1 && <span className="seeker_cursor" />}
                    </span>
                  );
                });
              })()}
            </div>
          </div>
        )}

        {/* Tool executions accordion */}
        {searchState === 'searching' && searchLogs.length > 0 && (
          <div className="hy-askai-tools">
            {searchLogs.map((log) => {
              const isRunning = log.status === 'running';
              const isFail = log.status === 'fail';
              const icon = isRunning ? '🔧' : isFail ? '✗' : '✓';
              const statusClass = isRunning
                ? 'hy-askai-status--running'
                : isFail
                  ? 'hy-askai-status--fail'
                  : 'hy-askai-status--ok';
              return (
                <div key={log.id} className="hy-askai-tool">
                  <div className="hy-askai-tool-head">
                    <div className="hy-askai-tool-title">
                      <span className={statusClass}>{icon}</span>
                      <span
                        className={isRunning ? 'hy-askai-tool-name hy-askai-tool-name--running' : 'hy-askai-tool-name'}
                      >
                        {isRunning ? `running ${log.name}...` : `${log.name}`}
                      </span>
                    </div>
                    {!isRunning && log.output && (
                      <button
                        onClick={() => {
                          onUpdateState({
                            searchLogs: searchLogs.map((item) =>
                              item.id === log.id ? {...item, expanded: !item.expanded} : item
                            )
                          });
                        }}
                        className="hy-askai-toggle"
                      >
                        {log.expanded ? '[collapse]' : '[view output]'}
                      </button>
                    )}
                  </div>
                  {log.expanded && !isRunning && (
                    <div className="hy-askai-tool-body">
                      {log.input && (
                        <div>
                          <div className="hy-askai-io-label">INPUT:</div>
                          <pre className="hy-askai-io">{JSON.stringify(log.input, null, 2)}</pre>
                        </div>
                      )}
                      {log.output && (
                        <div>
                          <div className="hy-askai-io-label">OUTPUT:</div>
                          <pre className="hy-askai-io">{log.output}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Follow-up bottom input field */}
      <div className="hy-askai-inputbar">
        <span className="hy-askai-spark">✨</span>
        <input
          type="text"
          className="hy-askai-input"
          placeholder="Ask a follow-up question..."
          value={aiInputVal}
          onChange={(e) => onUpdateState({aiInputVal: e.target.value})}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const val = aiInputVal.trim();
              if (val && searchState !== 'searching') {
                void onRunAiChat(conversationId, val);
              }
            }
          }}
          disabled={searchState === 'searching'}
        />
        {searchState === 'searching' ? (
          <button onClick={onStopAgentSearch} className="hy-askai-stop">
            [Stop]
          </button>
        ) : (
          <span className="hy-askai-enter">↵</span>
        )}
      </div>
    </div>
  );
};
