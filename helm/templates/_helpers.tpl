{{- define "skiff.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "skiff.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "skiff.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "skiff.labels" -}}
helm.sh/chart: {{ include "skiff.chart" . }}
{{ include "skiff.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "skiff.selectorLabels" -}}
app.kubernetes.io/name: {{ include "skiff.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* name of the secret to use — existing or generated */}}
{{- define "skiff.secretName" -}}
{{- if .Values.secret.existingSecret }}
{{- .Values.secret.existingSecret }}
{{- else }}
{{- include "skiff.fullname" . }}
{{- end }}
{{- end }}

{{/* name of the ollama service */}}
{{- define "skiff.ollamaName" -}}
{{- printf "%s-ollama" (include "skiff.fullname" .) }}
{{- end }}
