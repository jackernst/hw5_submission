import { useState } from 'react';
import Auth from './components/Auth';
import Chat from './components/Chat';
import YoutubeDownload from './components/YoutubeDownload';
import './App.css';

function App() {
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem('chatapp_user');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      // Backwards compatibility: older versions stored just the username string
      return { username: raw, firstName: '', lastName: '' };
    }
  });
  const [tab, setTab] = useState('chat');

  const handleLogin = (u) => {
    localStorage.setItem('chatapp_user', JSON.stringify(u));
    setUser(u);
  };

  const handleLogout = () => {
    localStorage.removeItem('chatapp_user');
    setUser(null);
  };

  if (user) {
    return (
      <div className="app-shell">
        <div className="app-topbar">
          <div className="app-brand">YouTube AI Chat Assistant</div>
          <div className="app-tabs">
            <button
              type="button"
              className={`app-tab${tab === 'chat' ? ' active' : ''}`}
              onClick={() => setTab('chat')}
            >
              Chat
            </button>
            <button
              type="button"
              className={`app-tab${tab === 'youtube' ? ' active' : ''}`}
              onClick={() => setTab('youtube')}
            >
              YouTube Channel Download
            </button>
          </div>
          <button type="button" className="app-logout" onClick={handleLogout}>
            Log out
          </button>
        </div>

        <div className="app-content">
          {tab === 'chat' ? (
            <Chat
              username={user.username}
              firstName={user.firstName}
              lastName={user.lastName}
              onLogout={handleLogout}
            />
          ) : (
            <YoutubeDownload />
          )}
        </div>
      </div>
    );
  }
  return <Auth onLogin={handleLogin} />;
}

export default App;
