# Gringo Online

Jogo de cartas Gringo para 2 a 6 jogadores, cada um no seu computador, através do browser.

## Instalar e correr

Precisas do Node.js 18 ou superior (https://nodejs.org).

```
npm install
npm start
```

O servidor arranca em http://localhost:3000.

## Jogar com amigos na mesma rede (casa, escola)

1. Corre `npm start` num dos computadores (se o Windows perguntar pela firewall, carrega em Permitir).
2. Descobre o IP desse computador (`ipconfig` no Windows, por exemplo 192.168.1.20).
3. Os outros abrem `http://192.168.1.20:3000` no browser.
4. Um cria a sala e os outros entram com o código de 4 letras (ou com o link "Copiar link da sala").

## Jogar pela internet (cada um em sua casa)

Põe a pasta num repositório do GitHub e publica-a num serviço gratuito de Node.js, como o Render:

1. Em https://render.com: New → Web Service → escolhe o repositório.
2. Build command: `npm install` · Start command: `npm start`.
3. Partilha o endereço que o Render te dá (por exemplo https://gringo-xxxx.onrender.com).

No plano gratuito, o servidor adormece quando não é usado e pode demorar cerca de 1 minuto a acordar no primeiro acesso.

## Regras implementadas

- Cada jogador recebe 4 cartas viradas para baixo e escolhe 2 para ver e memorizar.
- Na sua vez, tira uma carta do baralho (só ele a vê) e troca-a por uma das suas ou joga-a na mesa.
- Quando é jogada uma carta na mesa, qualquer jogador com uma carta do mesmo valor pode clicar nela para a jogar. Só uma pessoa consegue por jogada, por isso só passam duas cartas iguais. Se te enganares, a carta é mostrada e apanhas uma carta do baralho sem a ver.
- **Par**: se tiras uma carta e sabes que tens outra igual, podes jogar as duas. Se te enganares, apanhas uma carta sem ver.
- **Dama (Q)**: se a tiras e a jogas na mesa, podes ver uma das tuas cartas.
- **Valete (J)**: se o tiras e o jogas na mesa, trocas uma carta tua com uma de outro jogador, sem ninguém ver.
- **Rei (K)**: se o tiras e o jogas na mesa, vês uma carta de outro jogador e decides se a trocas por uma tua.
- **Gringo**: na tua vez, em vez de tirar carta. As tuas cartas ficam bloqueadas, os outros jogam mais uma vez e mostram-se todas as cartas.
- **Autogringo**: acontece automaticamente quando ficas sem cartas.
- Valores: A = 1, 2–10 = o próprio número, J e Q = 10, K♥ e K♦ = −3, K♠ e K♣ = 10.
- Ganha a ronda quem tiver menos pontos. Os pontos vão-se somando de ronda para ronda.
- Se atualizares a página, voltas ao teu lugar na mesma sala.
