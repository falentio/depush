import { useRegisterSW } from 'virtual:pwa-register/react'

export function usePwaUpdate() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true })

  return {
    needRefresh,
    reload: () => {
      void updateServiceWorker(true)
    },
    dismiss: () => setNeedRefresh(false),
  }
}
