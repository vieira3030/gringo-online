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

- Objetivo: ficar com menos pontos. A = 1, 2–10 = o próprio número, J, Q e K = 10, reis vermelhos (K♥ K♦) = −3.
- Cada jogador recebe 4 cartas viradas para baixo e só pode ver 2 no início.
- Na sua vez, tira uma carta do baralho (só ele a vê) e troca-a por uma das suas ou deita-a fora.
- **Cobrir**: quando alguém deita fora uma carta (por ex. um 6) e sabes onde tens um 6, clicas nele e pões por cima. Ficas com menos uma carta.
- **Só uma vez**: se outra pessoa cobrir a seguir, não vale — volta a ficar com a carta e apanha mais uma sem ver. O mesmo acontece se a carta que jogaste não for igual.
- **Cobrir com a carta de outro**: se sabes que outro jogador tem um 6, clicas no 6 dele e depois numa carta tua. O 6 dele cobre a mesa e ele fica com a tua carta. Ficas com menos uma. Se não for um 6, apanhas uma carta sem ver.
- **Par**: se tiras uma carta e sabes que tens outra igual, jogas as duas logo (uma cobre a outra).
- **Valete (J)**: trocas uma carta com outro jogador, sem ninguém ver.
- **Dama (Q)**: vês uma carta tua.
- **Rei (K)**: vês uma carta de outro jogador e decides se a trocas por uma tua.
- Os poderes só contam quando a figura é tirada do baralho e deitada fora.
- **Gringo**: dito na tua vez. Joga-se mais uma volta (quem disse já não joga) e contam-se os pontos.
- **Sem cartas**: se alguém ficar sem cartas, contam-se os pontos.
- Ganha a ronda quem tiver menos pontos. Os pontos vão-se somando de ronda para ronda.

### Opções do anfitrião (na sala de espera)

- **Pode-se cobrir a mesma carta várias vezes** (desligado por defeito).
- **Quem fica sem cartas acaba logo a ronda** (desligado por defeito: os outros jogam mais uma vez).
