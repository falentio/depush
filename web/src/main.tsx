import { createRoot } from 'react-dom/client'
import './styles.css'

const root = document.getElementById('root')
if (root === null) throw new Error('Missing #root')

createRoot(root).render(
  <main style={{ fontFamily: 'ui-sans-serif, system-ui', padding: 32 }}>
    <h1>depush console</h1>
  </main>,
)
