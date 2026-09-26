import { Route, Routes } from 'react-router-dom';
import { HostSetup } from './pages/HostSetup';
import { Tv } from './pages/Tv';
import { Play } from './pages/Play';
import { VisionLab } from './pages/VisionLab';
import { SyncTool } from './pages/SyncTool';
import { Camera } from './pages/Camera';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HostSetup />} />
      <Route path="/tv/:code" element={<Tv />} />
      <Route path="/play/:code" element={<Play />} />
      <Route path="/play" element={<Play />} />
      <Route path="/lab/vision" element={<VisionLab />} />
      <Route path="/sync/:gameId" element={<SyncTool />} />
      <Route path="/cam/:code" element={<Camera />} />
      <Route path="*" element={<HostSetup />} />
    </Routes>
  );
}
