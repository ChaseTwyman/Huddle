import { Route, Routes } from 'react-router-dom';
import { HostSetup } from './pages/HostSetup';
import { Tv } from './pages/Tv';
import { Play } from './pages/Play';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HostSetup />} />
      <Route path="/tv/:code" element={<Tv />} />
      <Route path="/play/:code" element={<Play />} />
      <Route path="/play" element={<Play />} />
      <Route path="*" element={<HostSetup />} />
    </Routes>
  );
}
