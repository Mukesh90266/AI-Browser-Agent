import useAgent from '../hooks/useAgent'

export default function VoiceControl() {
  const { callState, startVoiceCall, stopVoiceCall } = useAgent()
  const active = callState === 'connecting' || callState === 'connected'

  return (
    <button type="button" className={`voice-btn ${active ? 'active' : ''}`} onClick={active ? stopVoiceCall : startVoiceCall}>
      {callState === 'connecting' ? 'Connecting…' : active ? '■ End voice' : '🎙 Talk to Agent'}
    </button>
  )
}
