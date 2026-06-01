import { useState } from 'react'
import Bookshelf from './components/Bookshelf'
import Reader from './components/Reader'

type Route = { name: 'shelf' } | { name: 'reader'; bookId: string }

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'shelf' })

  if (route.name === 'reader') {
    return (
      <Reader
        bookId={route.bookId}
        onClose={() => setRoute({ name: 'shelf' })}
      />
    )
  }
  return <Bookshelf onOpenBook={(id) => setRoute({ name: 'reader', bookId: id })} />
}
