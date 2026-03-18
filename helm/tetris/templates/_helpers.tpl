{{/*
Expand the name of the chart.
*/}}
{{- define "tetris.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "tetris.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/name: {{ include "tetris.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "tetris.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tetris.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Redis URL — use override if set, else local redis service.
*/}}
{{- define "tetris.redisUrl" -}}
{{- if .Values.redis.url -}}
{{ .Values.redis.url }}
{{- else -}}
redis://redis.{{ .Release.Namespace }}.svc.cluster.local:6379
{{- end -}}
{{- end }}
