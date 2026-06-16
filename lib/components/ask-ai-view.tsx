import React from 'react';

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
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-primary)',
        position: 'relative',
        overflow: 'hidden'
      }}
      className="ai_pane_container"
    >
      {/* Chat feed scroll area */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          boxSizing: 'border-box'
        }}
        className="ai_pane_feed"
      >
        {activeConv.messages.map((msg, idx) => {
          const isUser = msg.role === 'user';
          return (
            <div
              key={idx}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: isUser ? 'flex-end' : 'flex-start',
                width: '100%'
              }}
            >
              <div
                style={{
                  maxWidth: '85%',
                  background: isUser ? 'var(--info-bg)' : 'var(--bg-secondary)',
                  color: isUser ? 'var(--info-text)' : 'var(--text-primary)',
                  border: '0.5px solid var(--border-neutral)',
                  borderRadius: '4px',
                  padding: '8px 12px',
                  boxSizing: 'border-box',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '11px',
                  lineHeight: '1.5',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word'
                }}
              >
                {(() => {
                  const parts = msg.content.split(/(```[\s\S]*?```)/g);
                  return parts.map((part: string, pIdx: number) => {
                    if (part.startsWith('```')) {
                      const code = part.replace(/```[a-zA-Z0-9]*\n?|```$/g, '');
                      return (
                        <pre
                          key={pIdx}
                          style={{
                            fontFamily: 'var(--font-mono)',
                            background: 'var(--bg-tertiary)',
                            padding: '8px',
                            borderRadius: '3px',
                            overflowX: 'auto',
                            margin: '6px 0 0 0',
                            border: '0.5px solid var(--border-neutral)',
                            textAlign: 'left'
                          }}
                        >
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
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              width: '100%'
            }}
          >
            <div
              style={{
                maxWidth: '85%',
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '0.5px solid var(--border-neutral)',
                borderRadius: '4px',
                padding: '8px 12px',
                boxSizing: 'border-box',
                fontFamily: 'var(--font-sans)',
                fontSize: '11px',
                lineHeight: '1.5',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              {(() => {
                const parts = aiStreamingMessage.split(/(```[\s\S]*?```)/g);
                return parts.map((part: string, pIdx: number) => {
                  if (part.startsWith('```')) {
                    const code = part.replace(/```[a-zA-Z0-9]*\n?|```$/g, '');
                    return (
                      <pre
                        key={pIdx}
                        style={{
                          fontFamily: 'var(--font-mono)',
                          background: 'var(--bg-tertiary)',
                          padding: '8px',
                          borderRadius: '3px',
                          overflowX: 'auto',
                          margin: '6px 0 0 0',
                          border: '0.5px solid var(--border-neutral)',
                          textAlign: 'left'
                        }}
                      >
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
          <div style={{display: 'flex', flexDirection: 'column', gap: '6px'}}>
            {searchLogs.map((log) => {
              const isRunning = log.status === 'running';
              const isFail = log.status === 'fail';
              const icon = isRunning ? '🔧' : isFail ? '✗' : '✓';
              const statusColor = isRunning
                ? 'var(--warning-text)'
                : isFail
                  ? 'var(--danger-text)'
                  : 'var(--success-text)';
              return (
                <div
                  key={log.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    border: '0.5px solid var(--border-neutral)',
                    borderRadius: '4px',
                    background: 'var(--bg-secondary)',
                    padding: '6px 12px',
                    boxSizing: 'border-box'
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: '11px',
                      fontFamily: 'var(--font-mono)'
                    }}
                  >
                    <div style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
                      <span style={{color: statusColor}}>{icon}</span>
                      <span style={{color: isRunning ? 'var(--text-primary)' : 'var(--text-secondary)'}}>
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
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: 'var(--info-text)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: '10px',
                          cursor: 'pointer',
                          padding: 0
                        }}
                      >
                        {log.expanded ? '[collapse]' : '[view output]'}
                      </button>
                    )}
                  </div>
                  {log.expanded && !isRunning && (
                    <div
                      style={{
                        marginTop: '6px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        textAlign: 'left'
                      }}
                    >
                      {log.input && (
                        <div>
                          <div
                            style={{
                              color: 'var(--text-tertiary)',
                              fontSize: '10px',
                              fontFamily: 'var(--font-mono)'
                            }}
                          >
                            INPUT:
                          </div>
                          <pre
                            style={{
                              fontFamily: 'var(--font-mono)',
                              background: 'var(--bg-tertiary)',
                              padding: '6px',
                              margin: 0,
                              borderRadius: '3px',
                              overflowX: 'auto',
                              border: '0.5px solid var(--border-neutral)',
                              fontSize: '10px'
                            }}
                          >
                            {JSON.stringify(log.input, null, 2)}
                          </pre>
                        </div>
                      )}
                      {log.output && (
                        <div>
                          <div
                            style={{
                              color: 'var(--text-tertiary)',
                              fontSize: '10px',
                              fontFamily: 'var(--font-mono)'
                            }}
                          >
                            OUTPUT:
                          </div>
                          <pre
                            style={{
                              fontFamily: 'var(--font-mono)',
                              background: 'var(--bg-tertiary)',
                              padding: '6px',
                              margin: 0,
                              borderRadius: '3px',
                              overflowX: 'auto',
                              border: '0.5px solid var(--border-neutral)',
                              fontSize: '10px'
                            }}
                          >
                            {log.output}
                          </pre>
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
      <div
        style={{
          padding: '12px 20px',
          borderTop: '0.5px solid var(--border-neutral)',
          background: 'var(--bg-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          boxSizing: 'border-box'
        }}
      >
        <span style={{fontSize: '12px', color: 'var(--color-ai-purple, #7F77DD)'}}>✨</span>
        <input
          type="text"
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-sans)',
            fontSize: '11px',
            padding: 0
          }}
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
          <button
            onClick={onStopAgentSearch}
            style={{
              background: 'var(--danger-bg)',
              color: 'var(--danger-text)',
              border: '0.5px solid var(--border-neutral)',
              borderRadius: '3px',
              fontSize: '10px',
              fontFamily: 'var(--font-mono)',
              padding: '2px 6px',
              cursor: 'pointer'
            }}
          >
            [Stop]
          </button>
        ) : (
          <span style={{fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)'}}>↵</span>
        )}
      </div>
    </div>
  );
};
