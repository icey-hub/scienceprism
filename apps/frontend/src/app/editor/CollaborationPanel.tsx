import { useTranslation } from 'react-i18next';

interface CollaborationPanelProps {
  collabStatus: 'connected' | 'connecting' | 'disconnected';
  collabServer: string;
  setCollabServerState: (value: string) => void;
  collabName: string;
  setCollabName: (value: string) => void;
  collabEnabled: boolean;
  onToggleConnection: () => void;
  canConnect: boolean;
  canInvite: boolean;
  collabInviteBusy: boolean;
  handleCreateInvite: () => void;
  copyInviteLink: () => void;
  collabInviteLink: string;
  activePath: string;
  collabPeers: { id: number; name: string; color: string }[];
}

export function CollaborationPanel({
  collabStatus,
  collabServer,
  setCollabServerState,
  collabName,
  setCollabName,
  collabEnabled,
  onToggleConnection,
  canConnect,
  canInvite,
  collabInviteBusy,
  handleCreateInvite,
  copyInviteLink,
  collabInviteLink,
  activePath,
  collabPeers
}: CollaborationPanelProps) {
  const { t } = useTranslation();
  return (
    <>
      <div className="panel-header">
        <div>{t('协作')}</div>
        <div className="panel-actions">
          <div className="collab-status">
            <span>{collabStatus === 'connected' ? t('已连接') : collabStatus === 'connecting' ? t('连接中...') : t('未连接')}</span>
          </div>
        </div>
      </div>
      <div className="collab-panel">
        <div className="collab-row">
          <input
            className="input"
            value={collabServer}
            onChange={(e) => setCollabServerState(e.target.value)}
            placeholder={t('协作服务器地址')}
          />
        </div>
        <div className="collab-row">
          <input
            className="input"
            value={collabName}
            onChange={(e) => setCollabName(e.target.value)}
            placeholder={t('显示名称')}
          />
          <button
            className="ios-btn secondary"
            onClick={onToggleConnection}
            disabled={!canConnect}
          >
            {collabEnabled ? t('断开') : t('连接')}
          </button>
        </div>
        <div className="collab-row">
          <button
            className="ios-btn primary"
            onClick={() => handleCreateInvite()}
            disabled={collabInviteBusy || !canInvite}
          >
            {collabInviteBusy ? t('生成中...') : t('生成邀请链接')}
          </button>
          <button
            className="ios-btn secondary"
            onClick={() => copyInviteLink()}
            disabled={!collabInviteLink}
          >
            {t('复制')}
          </button>
        </div>
        <div className="collab-row">
          <input
            className="input"
            readOnly
            value={collabInviteLink || ''}
            placeholder={t('尚未生成邀请链接')}
          />
        </div>
        <div className="collab-row">
          <div className="muted">
            {activePath ? t('当前文件: {{path}}', { path: activePath }) : t('未选择文件')}
          </div>
        </div>
        <div className="collab-users">
          {collabPeers.length === 0 ? (
            <div className="muted">{t('暂无协作者在线')}</div>
          ) : (
            collabPeers.map((peer) => (
              <div key={peer.id} className="collab-user">
                <span className="dot" style={{ background: peer.color }} />
                <span>{peer.name}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
